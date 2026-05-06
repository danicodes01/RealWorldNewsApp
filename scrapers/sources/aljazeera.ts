import * as cheerio from 'cheerio'
import { chromium, type Browser } from 'playwright'
import { env } from '../lib/env'
import { getPageText } from '../lib/browser'
import { extractArticle } from '../lib/haiku'
import { clearSource, ingestAll, type ArticlePayload } from '../lib/ingest'
import { slugify } from '../lib/slugify'
import { error, log } from '../lib/logger'

const SOURCE = 'aljazeera'
const SOURCE_NAME = 'Al Jazeera'
const BASE_URL = 'https://www.aljazeera.com'
const INDEX_URL = BASE_URL
const NEWS_PATH = /^https:\/\/www\.aljazeera\.com\/news\/\d{4}\/\d{1,2}\/\d{1,2}\//

// Mirrors the freshness floor in app/api/articles/route.ts. Keep them in sync.
const MAX_AGE_DAYS = 3
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

function extractPublishedTime($doc: cheerio.CheerioAPI): string {
  const metaTime = $doc('meta[property="article:published_time"]').attr('content')
  if (metaTime) return metaTime
  // Fallback: human-readable text like "5 May 2026" — V8's Date parser
  // handles it. Scoped to the dedicated date element so a byline can't
  // accidentally fall through.
  const dateText = $doc('.date-simple span[aria-hidden="true"]').first().text().trim()
  if (dateText) return dateText
  return ''
}

function toISO(input: string): string {
  if (!input) return new Date().toISOString()
  const parsed = new Date(input)
  if (isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

async function getArticleLinks(browser: Browser): Promise<string[]> {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  try {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    try {
      await page.click('#onetrust-accept-btn-handler', { timeout: 2_000 })
    } catch {
      // banner not present
    }

    const hrefs = await page.$$eval(
      'a.article-card__link, a.u-clickable-card__link',
      els => els.map(el => (el as HTMLAnchorElement).getAttribute('href') ?? ''),
    )

    const seen = new Set<string>()
    const allMatches: string[] = []
    for (const href of hrefs) {
      if (!href) continue
      const full = href.startsWith('http') ? href : `${BASE_URL}${href}`
      if (!NEWS_PATH.test(full)) continue
      if (seen.has(full)) continue
      seen.add(full)
      allMatches.push(full)
    }
    log(SOURCE, 'candidates', { totalOnPage: hrefs.length, matchingNewsUrls: allMatches.length })
    return env.SCRAPE_LIMIT > 0 ? allMatches.slice(0, env.SCRAPE_LIMIT) : allMatches
  } finally {
    await page.close()
  }
}

function extractAuthor(html: string): string {
  const $ = cheerio.load(html)
  const byline = $('.contributors-list--byline').first().clone()
  byline.find('.contributors-list__by-prefix').remove()
  return byline.text().replace(/\s+/g, ' ').trim()
}

function buildMinimalDoc(html: string): string {
  const $ = cheerio.load(html)

  const metas = [
    $('meta[property="og:title"]'),
    $('meta[property="og:description"]'),
    $('meta[property="og:image"]'),
    $('meta[property="article:published_time"]'),
    $('meta[property="article:modified_time"]'),
    $('meta[name="description"]'),
  ]
    .map(el => (el.length ? $.html(el) : ''))
    .filter(Boolean)
    .join('\n')

  const h1 = $('h1').first().text().trim()
  const subhead = $('.article__subhead').first().text().trim()
  const figImg = $('figure.article-featured-image img').first().attr('src') ?? ''
  const dateText = $('.date-simple span[aria-hidden="true"]').first().text().trim()

  const bodyParas: string[] = []
  $('.wysiwyg--all-content, .wysiwyg').first().find('> p').each((_, el) => {
    const text = $(el).text().trim()
    if (text) bodyParas.push(`<p>${text}</p>`)
  })

  return `<!doctype html><html><head>${metas}</head><body>
<h1>${h1}</h1>
${subhead ? `<p class="subhead">${subhead}</p>` : ''}
${figImg ? `<img src="${figImg}">` : ''}
${dateText ? `<time>${dateText}</time>` : ''}
${bodyParas.join('\n')}
</body></html>`
}

async function run() {
  log(SOURCE, 'start', { index: INDEX_URL, limit: env.SCRAPE_LIMIT })

  const browser = await chromium.launch({ headless: true })
  const payloads: ArticlePayload[] = []
  let skippedStale = 0
  let skippedOther = 0
  try {
    const urls = await getArticleLinks(browser)
    log(SOURCE, 'found-links', { count: urls.length })

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const t0 = Date.now()
      log(SOURCE, 'extract-start', { index: i + 1, of: urls.length, url })
      try {
        const raw = await getPageText(browser, url)
        const $doc = cheerio.load(raw)
        const publishedTime = extractPublishedTime($doc)
        // Pre-Haiku freshness check: if we can confirm the article is older
        // than the floor, skip the extraction call entirely. If the date is
        // missing/unparseable we still proceed — the ingest endpoint will
        // catch stale articles as a backstop.
        if (publishedTime) {
          const articleMs = new Date(publishedTime).getTime()
          if (!isNaN(articleMs) && articleMs < Date.now() - MAX_AGE_MS) {
            const ageDays = Math.floor((Date.now() - articleMs) / (24 * 60 * 60 * 1000))
            log(SOURCE, 'skipped-stale', { url, ageDays, publishedTime })
            skippedStale++
            continue
          }
        }
        const author = extractAuthor(raw)
        const minimal = buildMinimalDoc(raw)
        log(SOURCE, 'prompt-size', { index: i + 1, chars: minimal.length })
        const data = await extractArticle(minimal)
        if (!data.headline) {
          log(SOURCE, 'skipped-no-headline', { url })
          skippedOther++
          continue
        }
        payloads.push({
          slug: slugify(data.headline),
          headline: data.headline,
          summary: data.summary,
          body: data.body,
          location: data.location,
          media: data.media,
          author,
          source: SOURCE_NAME,
          sourceUrl: url,
          date: toISO(publishedTime || data.date),
        })
        log(SOURCE, 'extract-done', { index: i + 1, ms: Date.now() - t0 })
      } catch (err) {
        error(SOURCE, 'extract-failed', { url, message: (err as Error).message })
        skippedOther++
      }
    }
  } finally {
    await browser.close()
  }

  log(SOURCE, 'summary', {
    extracted: payloads.length,
    skippedStale,
    skippedOther,
  })

  if (payloads.length === 0) {
    log(SOURCE, 'done-empty', { reason: 'no payloads — keeping existing rows' })
    return
  }

  const clearCount = await clearSource(SOURCE, SOURCE_NAME)
  log(SOURCE, 'cleared', { count: clearCount })

  const result = await ingestAll(SOURCE, payloads)
  log(SOURCE, 'done', result)
}

run().catch(err => {
  error(SOURCE, 'fatal', { message: (err as Error).message })
  process.exit(1)
})

import * as cheerio from 'cheerio'
import { chromium, type Browser } from 'playwright'
import { env } from '../lib/env'
import { getPageText } from '../lib/browser'
import { extractArticle } from '../lib/haiku'
import { clearSource, ingestAll, type ArticlePayload } from '../lib/ingest'
import { slugify } from '../lib/slugify'
import { error, log } from '../lib/logger'

const SOURCE = 'jacobin'
const SOURCE_NAME = 'Jacobin'
const BASE_URL = 'https://jacobin.com'
const INDEX_URL = BASE_URL
const STORY_PATH = /^https:\/\/jacobin\.com\/\d{4}\/\d{1,2}\/[a-z0-9-]+\/?$/

// Mirrors the freshness floor in app/api/articles/route.ts. Keep them in sync.
const MAX_AGE_DAYS = 3
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

function extractPublishedTime($doc: cheerio.CheerioAPI): string {
  const metaTime = $doc('meta[property="article:published_time"]').attr('content')
  if (metaTime) return metaTime
  // Fallback: post-header date element. The .po-hr- prefix is scoped to
  // article-header so .first() can't accidentally match a related-stories rail.
  const dateText = $doc('time.po-hr-fl__date').first().text().trim()
  if (dateText) return dateText
  return ''
}

function toISO(input: string): string {
  if (!input) return new Date().toISOString()
  const parsed = new Date(input)
  if (isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

async function dismissSubscribePopup(page: Awaited<ReturnType<Browser['newPage']>>) {
  const selectors = [
    '#mailing-list-popup button[aria-label*="close" i]',
    '#mailing-list-popup .close',
    'button[aria-label="Close"]',
    'button:has-text("No thanks")',
    'button:has-text("Close")',
  ]
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: 1_500 })
      return
    } catch {
      // try next
    }
  }
}

async function getArticleLinks(browser: Browser): Promise<string[]> {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  try {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForSelector('a.hm-dg__link', { timeout: 15_000 }).catch(() => {
      // listing may still render under a different variant; fall back to whatever matched
    })
    await dismissSubscribePopup(page)

    const hrefs = await page.$$eval(
      'a.hm-dg__link, article.hm-dg__article a[href^="/"]',
      els => els.map(el => (el as HTMLAnchorElement).getAttribute('href') ?? ''),
    )

    const seen = new Set<string>()
    const allMatches: string[] = []
    for (const href of hrefs) {
      if (!href) continue
      const full = href.startsWith('http') ? href : `${BASE_URL}${href}`
      if (!STORY_PATH.test(full)) continue
      if (seen.has(full)) continue
      seen.add(full)
      allMatches.push(full)
    }
    log(SOURCE, 'candidates', { totalOnPage: hrefs.length, matchingStoryUrls: allMatches.length })
    return env.SCRAPE_LIMIT > 0 ? allMatches.slice(0, env.SCRAPE_LIMIT) : allMatches
  } finally {
    await page.close()
  }
}

function buildMinimalDoc(html: string): string {
  const $ = cheerio.load(html)

  $('aside, .sr-at__slot, .po-sr-sb, .po-sr-ed, .po-ca-rp, .po-ca-au, .po-ca-xc, .bn-at, #mailing-list-popup, script, style, noscript, iframe').remove()

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

  const h1 = $('h1.po-hr-cn__title').first().text().trim() || $('h1').first().text().trim()
  const dek = $('p.po-hr-cn__dek').first().text().trim()
  const ogImg = $('meta[property="og:image"]').attr('content') ?? ''
  const heroImg = ogImg || $('img.po-hr-im__image').first().attr('src') || ''
  const dateText = $('time.po-hr-fl__date').first().text().trim()
  const author = $('.po-hr-cn__author-link').first().text().trim()

  const bodyParas: string[] = []
  const container = $('#post-content').first()
  container.find('section.po-cn__intro > p, section.po-cn__section > p, section.po-cn__section > h1.po-cn__subhead').each((_, el) => {
    const $el = $(el)
    const text = $el.text().trim()
    if (!text) return
    const isSubhead = $el.hasClass('po-cn__subhead')
    bodyParas.push(isSubhead ? `<h2>${text}</h2>` : `<p>${text}</p>`)
  })

  if (bodyParas.length === 0) {
    container.find('p').each((_, el) => {
      const text = $(el).text().trim()
      if (text) bodyParas.push(`<p>${text}</p>`)
    })
  }

  return `<!doctype html><html><head>${metas}</head><body>
<h1>${h1}</h1>
${dek ? `<p class="dek">${dek}</p>` : ''}
${heroImg ? `<img src="${heroImg}">` : ''}
${dateText ? `<time>${dateText}</time>` : ''}
${author ? `<p class="author">By ${author}</p>` : ''}
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
        const ogImg = $doc('meta[property="og:image"]').attr('content') ?? ''
        const authorNames: string[] = []
        $doc('.po-hr-cn__author-link, a[href^="/author/"]').each((_, el) => {
          const name = $doc(el).text().trim()
          if (name && !authorNames.includes(name)) authorNames.push(name)
        })
        const author = authorNames.join(', ')
        const minimal = buildMinimalDoc(raw)
        log(SOURCE, 'prompt-size', { index: i + 1, chars: minimal.length, hasImage: Boolean(ogImg) })
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
          media: ogImg || data.media,
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

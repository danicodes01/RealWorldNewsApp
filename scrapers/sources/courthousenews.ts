import * as cheerio from 'cheerio'
import { chromium, type Browser } from 'playwright'
import { env } from '../lib/env'
import { getPageText } from '../lib/browser'
import { extractArticle } from '../lib/haiku'
import { clearSource, ingestAll, type ArticlePayload } from '../lib/ingest'
import { slugify } from '../lib/slugify'
import { error, log } from '../lib/logger'

const SOURCE = 'courthousenews'
const SOURCE_NAME = 'Courthouse News'
const BASE_URL = 'https://www.courthousenews.com'
const INDEX_URL = 'https://courthousenews.com/'
const STORY_PATH = /^https:\/\/(?:www\.)?courthousenews\.com\/(?!(?:category|author|tag|page|wp-content|wp-admin|wp-includes|feed)\/)[a-z0-9][a-z0-9-]*\/?$/

// Mirrors the freshness floor in app/api/articles/route.ts. Keep them in sync.
const MAX_AGE_DAYS = 3
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

function extractPublishedTime($doc: cheerio.CheerioAPI): string {
  const metaTime = $doc('meta[property="article:published_time"]').attr('content')
  if (metaTime) return metaTime
  // Fallback: ".author-date span" text — the leading "/" separator is stripped.
  // Format is typically "April 28, 2026" after the strip.
  const dateText = $doc('.author-date span').first().text().trim().replace(/^\/\s*/, '')
  if (dateText) return dateText
  return ''
}

function toISO(input: string): string {
  if (!input) return new Date().toISOString()
  const parsed = new Date(input)
  if (isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

async function dismissPopup(page: Awaited<ReturnType<Browser['newPage']>>) {
  const selectors = [
    'button[aria-label="Close"]',
    'button[aria-label*="close" i]',
    '.popup-close',
    '.modal-close',
    '.close-button',
    'button.close',
    '[class*="newsletter"] button[class*="close"]',
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

type Candidate = { url: string; author: string }

async function getArticleLinks(browser: Browser): Promise<Candidate[]> {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  try {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await dismissPopup(page)

    const html = await page.content()
    const $ = cheerio.load(html)

    const seen = new Set<string>()
    const candidates: Candidate[] = []
    let totalCards = 0
    $('.arpr_article_preview').each((_, card) => {
      totalCards += 1
      const $card = $(card)
      const href = $card.find('h2 a').first().attr('href') ?? $card.find('.image a').first().attr('href') ?? ''
      if (!href) return
      const full = href.startsWith('http') ? href : `${BASE_URL}${href}`
      if (!STORY_PATH.test(full)) return
      if (seen.has(full)) return
      seen.add(full)

      const authorNames: string[] = []
      $card.find('p.author a, .author a, .entry-byline a').each((_, a) => {
        const name = $(a).text().trim()
        if (name && !authorNames.includes(name)) authorNames.push(name)
      })
      candidates.push({ url: full, author: authorNames.join(', ') })
    })

    log(SOURCE, 'candidates', { totalCards, matchingStoryUrls: candidates.length })
    return env.SCRAPE_LIMIT > 0 ? candidates.slice(0, env.SCRAPE_LIMIT) : candidates
  } finally {
    await page.close()
  }
}

function buildMinimalDoc(html: string): string {
  const $ = cheerio.load(html)

  $('aside, .related-articles, #email-subscribers, .article-categories, .share, .footer_widgets, .article-author-follow, script, style, noscript, iframe').remove()

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

  const h1 = $('.article-header h1').first().text().trim() || $('h1').first().text().trim()
  const excerpt = $('.article-header .excerpt').first().text().trim()
  const ogImg = $('meta[property="og:image"]').attr('content') ?? ''
  const heroImg = ogImg || $('figure.featured-image img').first().attr('src') || ''
  const dateText = $('.author-date span').first().text().trim().replace(/^\/\s*/, '')

  const bodyParas: string[] = []
  const container = $('.article-content').first()
  container.find('> p').each((_, el) => {
    const text = $(el).text().trim()
    if (text) bodyParas.push(`<p>${text}</p>`)
  })

  return `<!doctype html><html><head>${metas}</head><body>
<h1>${h1}</h1>
${excerpt ? `<p class="dek">${excerpt}</p>` : ''}
${heroImg ? `<img src="${heroImg}">` : ''}
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
    const candidates = await getArticleLinks(browser)
    log(SOURCE, 'found-links', { count: candidates.length })

    for (let i = 0; i < candidates.length; i++) {
      const { url, author: listingAuthor } = candidates[i]
      const t0 = Date.now()
      log(SOURCE, 'extract-start', { index: i + 1, of: candidates.length, url })
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
        const slugAuthorNames: string[] = []
        $doc('p.author a, .entry-byline a[href*="/author/"]').each((_, el) => {
          const name = $doc(el).text().trim()
          if (name && !slugAuthorNames.includes(name)) slugAuthorNames.push(name)
        })
        const author = slugAuthorNames.length > 0 ? slugAuthorNames.join(', ') : listingAuthor
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

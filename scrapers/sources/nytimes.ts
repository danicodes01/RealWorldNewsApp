import * as cheerio from 'cheerio'
import { env } from '../lib/env'
import { clearSource, ingestAll, type ArticlePayload } from '../lib/ingest'
import { slugify } from '../lib/slugify'
import { error, log } from '../lib/logger'

const SOURCE = 'nytimes'
const SOURCE_NAME = 'The New York Times'
// NYT's homepage RSS feed. PerimeterX-protected article pages are unscrapable,
// but the RSS is free, stable, and gives us everything we need.
const FEED_URL = 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'

// Mirrors the freshness floor in app/api/articles/route.ts. Keep them in sync.
const MAX_AGE_DAYS = 3
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

function toISO(input: string): string {
  if (!input) return new Date().toISOString()
  const parsed = new Date(input)
  if (isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

async function fetchFeed(): Promise<string> {
  const res = await fetch(FEED_URL, {
    headers: {
      // RSS endpoint is unauthenticated and unprotected, but a real UA never hurts.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
  })
  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status}`)
  }
  return res.text()
}

async function run() {
  log(SOURCE, 'start', { feed: FEED_URL, limit: env.SCRAPE_LIMIT })

  const xml = await fetchFeed()
  const $ = cheerio.load(xml, { xml: true })

  const items = $('item').toArray()
  log(SOURCE, 'feed-items', { count: items.length })

  const payloads: ArticlePayload[] = []
  let skippedStale = 0
  let skippedOther = 0

  for (let i = 0; i < items.length; i++) {
    if (env.SCRAPE_LIMIT > 0 && payloads.length >= env.SCRAPE_LIMIT) break

    const item = $(items[i])
    const headline = decodeEntities(item.find('title').first().text().trim())
    const link = item.find('link').first().text().trim()
    const summary = decodeEntities(item.find('description').first().text().trim())
    const pubDate = item.find('pubDate').first().text().trim()
    const creator = item.find('dc\\:creator, creator').first().text().trim()
    // RSS media: prefer media:content (full image), fall back to media:thumbnail.
    const mediaContent =
      item.find('media\\:content, content').filter((_, el) => $(el).attr('medium') === 'image').first().attr('url') ?? ''
    const mediaThumb = item.find('media\\:thumbnail, thumbnail').first().attr('url') ?? ''
    const image = mediaContent || mediaThumb

    if (!headline || !link || !pubDate) {
      log(SOURCE, 'skipped-incomplete', { index: i + 1, hasHeadline: !!headline, hasLink: !!link, hasDate: !!pubDate })
      skippedOther++
      continue
    }

    const articleMs = new Date(pubDate).getTime()
    if (!isNaN(articleMs) && articleMs < Date.now() - MAX_AGE_MS) {
      const ageDays = Math.floor((Date.now() - articleMs) / (24 * 60 * 60 * 1000))
      log(SOURCE, 'skipped-stale', { link, ageDays, pubDate })
      skippedStale++
      continue
    }

    payloads.push({
      slug: slugify(headline),
      headline,
      summary,
      // Body field is required by the ingest contract. RSS gives us the summary,
      // so reuse it as the body — readers click out to nytimes.com for full text.
      body: summary,
      location: '',
      media: image,
      author: creator.replace(/^By\s+/i, '').trim(),
      source: SOURCE_NAME,
      sourceUrl: link,
      date: toISO(pubDate),
    })
    log(SOURCE, 'item', { index: i + 1, headline, hasImage: !!image })
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

import { env } from './env'
import { error, log } from './logger'

export type ArticlePayload = {
  slug: string
  headline: string
  summary: string
  body: string
  location: string
  media: string
  bodyBlocks?: string
  videoUrl?: string
  author?: string
  source: string
  sourceUrl: string
  date: string
}

export type IngestResult = {
  created: number
  updated: number
  skipped: number
  failed: number
}

export async function ingestArticle(source: string, payload: ArticlePayload): Promise<'created' | 'updated' | 'skipped' | 'failed'> {
  const res = await fetch(env.INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  })

  if (res.status === 201) {
    log(source, 'created', { slug: payload.slug })
    return 'created'
  }
  if (res.status === 200) {
    log(source, 'updated', { slug: payload.slug })
    return 'updated'
  }
  if (res.status === 409) {
    log(source, 'skipped', { slug: payload.slug })
    return 'skipped'
  }

  const text = await res.text().catch(() => '')
  error(source, 'failed', { slug: payload.slug, status: res.status, body: text.slice(0, 300) })
  return 'failed'
}

export async function ingestAll(source: string, items: ArticlePayload[]): Promise<IngestResult> {
  const result: IngestResult = { created: 0, updated: 0, skipped: 0, failed: 0 }
  for (const item of items) {
    const outcome = await ingestArticle(source, item)
    result[outcome] += 1
  }
  return result
}

export async function clearSource(sourceTag: string, sourceName: string): Promise<number> {
  const url = new URL(env.INGEST_URL)
  url.searchParams.set('source', sourceName)
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.INGEST_SECRET}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    error(sourceTag, 'clear-failed', { status: res.status, body: text.slice(0, 300) })
    throw new Error(`clearSource failed: ${res.status}`)
  }
  const body = (await res.json().catch(() => ({}))) as { deleted?: number }
  return body.deleted ?? 0
}

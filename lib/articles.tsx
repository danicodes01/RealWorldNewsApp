import { prisma } from "@/lib/prisma";
import { Article } from "../types/article";

const PAGE_SIZE = 12;

// Sources whose existing rows should be hidden from the UI even though they
// remain in the DB. Used to park a scraper while keeping the data for later
// debugging/restoration. Mirror this in app/page.tsx KNOWN_SOURCES comments
// so the source tab doesn't show either.
const HIDDEN_SOURCES = new Set<string>([
  "Drop Site News", // re-surfacing old articles with today's date — see WORK_LOG.md
]);

export interface SourceCount {
  source: string;
  count: number;
}

export async function getArticles(
  searchQuery?: string,
  page: number = 1,
  source?: string,
  pageSize: number = PAGE_SIZE,
): Promise<{
  articles: Article[];
  totalArticles: number;
  sourceCounts: SourceCount[];
  totalAcrossAllSources: number;
}> {
  const searchWhere = searchQuery
    ? {
        OR: [
          { headline: { contains: searchQuery, mode: "insensitive" as const } },
          { body: { contains: searchQuery, mode: "insensitive" as const } },
          { summary: { contains: searchQuery, mode: "insensitive" as const } },
          { location: { contains: searchQuery, mode: "insensitive" as const } },
          { source: { contains: searchQuery, mode: "insensitive" as const } },
          { author: { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }
    : {};

  const rawSearchScoped = await prisma.article.findMany({
    where: searchWhere,
    orderBy: { date: "desc" },
  });
  const searchScoped = rawSearchScoped.filter((a) => !HIDDEN_SOURCES.has(a.source));

  const sourceCountMap = new Map<string, number>();
  for (const a of searchScoped) {
    const key = a.source || "unknown";
    sourceCountMap.set(key, (sourceCountMap.get(key) ?? 0) + 1);
  }
  const sourceCounts: SourceCount[] = Array.from(sourceCountMap.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => a.source.localeCompare(b.source));

  const filtered = source
    ? searchScoped.filter((a) => a.source === source)
    : searchScoped;

  const staggered = source ? filtered : interleaveByDayAndSource(filtered);
  const start = (page - 1) * pageSize;
  const articles = staggered.slice(start, start + pageSize);

  return {
    articles,
    totalArticles: staggered.length,
    sourceCounts,
    totalAcrossAllSources: searchScoped.length,
  };
}

function dayKey(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}

function roundRobinBySource(articles: Article[]): Article[] {
  const queues = new Map<string, Article[]>();
  for (const a of articles) {
    const key = a.source || "unknown";
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push(a);
  }

  const out: Article[] = [];
  const lists = Array.from(queues.values());
  let remaining = articles.length;
  while (remaining > 0) {
    for (const list of lists) {
      const next = list.shift();
      if (next) {
        out.push(next);
        remaining--;
      }
    }
  }
  return out;
}

function interleaveByDayAndSource(articles: Article[]): Article[] {
  const byDay = new Map<string, Article[]>();
  for (const a of articles) {
    const key = dayKey(a.date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(a);
  }

  const days = Array.from(byDay.keys()).sort().reverse();
  const out: Article[] = [];
  for (const day of days) {
    out.push(...roundRobinBySource(byDay.get(day)!));
  }
  return out;
}

export async function getArticle(slug: string): Promise<Article | null> {
  return prisma.article.findUnique({ where: { slug } });
}

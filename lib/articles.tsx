import { prisma } from "@/lib/prisma";
import { Article } from "../types/article";

const PAGE_SIZE = 10;

export async function getArticles(
  searchQuery?: string,
  page: number = 1,
  pageSize: number = PAGE_SIZE,
): Promise<{ articles: Article[]; totalArticles: number }> {
  const where = searchQuery
    ? {
        OR: [
          { headline: { contains: searchQuery, mode: "insensitive" as const } },
          { body: { contains: searchQuery, mode: "insensitive" as const } },
          { summary: { contains: searchQuery, mode: "insensitive" as const } },
          { location: { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [articles, totalArticles] = await Promise.all([
    prisma.article.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.article.count({ where }),
  ]);

  return { articles, totalArticles };
}

export async function getArticle(slug: string): Promise<Article | null> {
  return prisma.article.findUnique({ where: { slug } });
}

import ArticleGrid from "@/components/articles/article-grid";
import classes from "./page.module.css";
import { getArticles } from "@/lib/articles";
import SearchBar from "@/components/search/search-bar";
import SourceTabs from "@/components/articles/source-tabs";
import PaginationWrapper from "@/components/ui/pagination/pagination-wrapper";

export const revalidate = 60;

interface HomeProps {
  searchParams: Promise<{ q?: string; page?: string; source?: string }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const { q, page, source } = await searchParams;
  const searchQuery = q?.trim() || undefined;
  const activeSource = source?.trim() || "";
  const currentPage = Math.max(1, Number(page) || 1);

  const { articles, totalArticles, sourceCounts, totalAcrossAllSources } =
    await getArticles(searchQuery, currentPage, activeSource || undefined);
  const totalPages = Math.max(1, Math.ceil(totalArticles / 12));

  const KNOWN_SOURCES = [
    "Al Jazeera",
    "BBC News",
    "Borderland Beat",
    "Courthouse News",
    "Democracy Now!",
    "Drop Site News",
    "Jacobin",
    "NPR",
    "The Intercept",
  ];
  const countBySource = new Map(sourceCounts.map((s) => [s.source, s.count]));
  const tabOptions = KNOWN_SOURCES.map((name) => ({
    value: name,
    label: name,
    count: countBySource.get(name) ?? 0,
  }));
  for (const s of sourceCounts) {
    if (!KNOWN_SOURCES.includes(s.source)) {
      tabOptions.push({ value: s.source, label: s.source, count: s.count });
    }
  }

  return (
    <main className={classes.header}>
      <SearchBar key={activeSource} initialQuery={searchQuery ?? ""} />
      <SourceTabs
        options={tabOptions}
        active={activeSource}
        totalCount={totalAcrossAllSources}
      />
      {searchQuery && totalArticles > 0 && (
        <p className={classes.results}>
          {totalArticles} {totalArticles === 1 ? "article" : "articles"} found
        </p>
      )}
      <ArticleGrid articles={articles} />
      {articles.length === 0 && (
        <p className={classes.noResults}>No articles found...</p>
      )}
      <PaginationWrapper currentPage={currentPage} totalPages={totalPages} />
    </main>
  );
}

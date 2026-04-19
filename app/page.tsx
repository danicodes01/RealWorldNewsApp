import ArticleGrid from "@/components/articles/article-grid";
import classes from "./page.module.css";
import { getArticles } from "@/lib/articles";
import SearchBar from "@/components/search/search-bar";
import ScrollRestorationWrapper from "@/components/articles/scroll-restoration-wrapper";
import PaginationWrapper from "@/components/ui/pagination/pagination-wrapper";

export const dynamic = "force-dynamic";

interface HomeProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const { q, page } = await searchParams;
  const searchQuery = q?.trim() || undefined;
  const currentPage = Math.max(1, Number(page) || 1);

  const { articles, totalArticles } = await getArticles(searchQuery, currentPage);
  const totalPages = Math.max(1, Math.ceil(totalArticles / 10));

  return (
    <ScrollRestorationWrapper>
      <main className={classes.header}>
        <SearchBar initialQuery={searchQuery ?? ""} />
        {searchQuery && articles.length > 0 && (
          <p className={classes.results}>
            {articles.length} {articles.length === 1 ? "article" : "articles"} found
          </p>
        )}
        <ArticleGrid articles={articles} />
        {searchQuery && articles.length === 0 && (
          <p className={classes.noResults}>No articles found...</p>
        )}
        <PaginationWrapper currentPage={currentPage} totalPages={totalPages} />
      </main>
    </ScrollRestorationWrapper>
  );
}

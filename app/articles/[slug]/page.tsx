import type { Metadata } from "next";
import { getArticle } from "@/lib/articles";
import classes from "./page.module.css";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import Video from "@/components/video/video";
import AgeGate from "@/components/articles/age-gate";

const SENSITIVE_SOURCES = new Set(["Borderland Beat"]);
const SITE_URL = "https://www.realworldnews.org";

export const revalidate = 60;

type BodyBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "image"; src: string; alt: string };

function parseBodyBlocks(json: string): BodyBlock[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((b): b is BodyBlock => {
      if (!b || typeof b !== "object") return false;
      if (b.type === "paragraph") return typeof b.text === "string";
      if (b.type === "heading")
        return (b.level === 2 || b.level === 3) && typeof b.text === "string";
      if (b.type === "image")
        return typeof b.src === "string" && /^https:\/\//i.test(b.src);
      return false;
    });
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

interface ArticleDetailParams {
  params: Promise<{
    slug: string;
  }>;
}

function truncate(text: string, max = 160) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

export async function generateMetadata({
  params,
}: ArticleDetailParams): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) {
    return {
      title: "Article not found",
      robots: { index: false, follow: false },
    };
  }

  const description = truncate(article.summary || article.body);
  const url = `/articles/${article.slug}`;
  const images = article.media ? [{ url: article.media, alt: article.headline }] : undefined;

  return {
    title: article.headline,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: article.headline,
      description,
      url,
      type: "article",
      publishedTime: article.date ? new Date(article.date).toISOString() : undefined,
      authors: article.source ? [article.source] : undefined,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: article.headline,
      description,
      images: article.media ? [article.media] : undefined,
    },
  };
}

export default async function ArticleDetailPage({ params }: ArticleDetailParams) {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) notFound();
  const humanReadableDate = new Date(article.date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const blocks = parseBodyBlocks(article.bodyBlocks);
  const paragraphs = article.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const isSensitive = SENSITIVE_SOURCES.has(article.source);

  const articleUrl = `${SITE_URL}/articles/${article.slug}`;
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: article.headline,
        item: articleUrl,
      },
    ],
  };

  const newsArticleSchema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.headline,
    description: article.summary || undefined,
    image: article.media ? [article.media] : undefined,
    datePublished: article.date ? new Date(article.date).toISOString() : undefined,
    dateModified: article.date ? new Date(article.date).toISOString() : undefined,
    author: article.author
      ? article.author
          .split(",")
          .map((name) => ({ "@type": "Person", name: name.trim() }))
          .filter((a) => a.name.length > 0)
      : article.source
        ? { "@type": "Organization", name: article.source, url: article.sourceUrl || undefined }
        : undefined,
    publisher: {
      "@type": "NewsMediaOrganization",
      name: "Real World News",
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/header-logo-mono.png`,
      },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl },
    isBasedOn: article.sourceUrl || undefined,
  };

  const content = (
    <article className={classes.wrap}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbSchema).replace(/</g, "\\u003c"),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(newsArticleSchema).replace(/</g, "\\u003c"),
        }}
      />
      <Link href="/" className={classes.backLink}>← All articles</Link>

      <header className={classes.head}>
        <h1 className={classes.title}>
          {article.sourceUrl ? (
            <a
              href={article.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={classes.titleLink}
            >
              {article.headline}
            </a>
          ) : (
            article.headline
          )}
        </h1>
        {article.summary && <p className={classes.summary}>{article.summary}</p>}
        <div className={classes.meta}>
          {article.author && <span>By {article.author}</span>}
          {article.location && <span>{article.location}</span>}
          <span>{humanReadableDate}</span>
        </div>
      </header>

      {article.videoUrl ? (
        <div className={classes.image}>
          <Video media={article.videoUrl} poster={article.media || undefined} />
        </div>
      ) : article.media ? (
        article.sourceUrl ? (
          <a
            href={article.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={classes.image}
          >
            <Image
              src={article.media}
              alt={article.slug}
              fill
              priority
              sizes="(max-width: 768px) 100vw, 800px"
            />
          </a>
        ) : (
          <div className={classes.image}>
            <Image
              src={article.media}
              alt={article.slug}
              fill
              priority
              sizes="(max-width: 768px) 100vw, 800px"
            />
          </div>
        )
      ) : null}

      <div className={classes.body}>
        {blocks
          ? blocks.map((b, i) => {
              if (b.type === "image") {
                return (
                  <figure key={i} className={classes.bodyImage}>
                    <Image
                      src={b.src}
                      alt={b.alt || article.headline}
                      width={1200}
                      height={800}
                      sizes="(max-width: 768px) 100vw, 672px"
                    />
                  </figure>
                );
              }
              if (b.type === "heading") {
                return b.level === 2 ? (
                  <h2 key={i} className={classes.bodyHeading}>{b.text}</h2>
                ) : (
                  <h3 key={i} className={classes.bodyHeading}>{b.text}</h3>
                );
              }
              return <p key={i}>{b.text}</p>;
            })
          : paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      </div>

      {article.sourceUrl && (
        <div className={classes.sourceLinkWrap}>
          <a
            className={classes.sourceLink}
            href={article.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the full story on {article.source || "the original source"} →
          </a>
        </div>
      )}
    </article>
  );

  if (isSensitive) {
    return <AgeGate sourceLabel={article.source}>{content}</AgeGate>;
  }
  return content;
}

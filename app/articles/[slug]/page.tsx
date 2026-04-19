import { getArticle } from "@/lib/articles";
import classes from "./page.module.css";
import Image from "next/image";
import { notFound } from "next/navigation";
import Video from "@/components/video/video";

export const dynamic = "force-dynamic";

interface ArticleDetailParams {
  params: Promise<{
    slug: string;
  }>;
}

const isVideo = (media: string): boolean => {
  const videoIndicators = ["video", ".mp4", ".webm", ".ogg"];
  return videoIndicators.some((indicator) => media.includes(indicator));
};

export default async function ArticleDetailPage({ params }: ArticleDetailParams) {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) notFound();

  const mediaIsVideo = isVideo(article.media);
  const humanReadableDate = new Date(article.date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const body = article.body.replace(/\n/g, "<br />");

  return (
    <header className={classes.header}>
      <div className={classes.headerText}>
        <h1>{article.headline}</h1>
        <div className={classes.image}>
          {mediaIsVideo ? (
            <Video media={article.media} />
          ) : (
            article.media && <Image src={article.media} alt={article.slug} fill />
          )}
        </div>
        <div className={classes.info}>
          {article.location && <p>{article.location}</p>}
          <p>{humanReadableDate}</p>
        </div>
      </div>
      <main>
        <p
          className={classes.description}
          dangerouslySetInnerHTML={{ __html: body }}
        ></p>
      </main>
    </header>
  );
}

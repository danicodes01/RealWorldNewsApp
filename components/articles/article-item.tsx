import classes from "./article-item.module.css";
import Video from "../video/video";
import Image from "next/image";
import Link from "next/link";
import { Article } from "@/types/article";

const isVideo = (media: string): boolean => {
  const videoIndicators = ["video", ".mp4", ".webm", ".ogg"];
  return videoIndicators.some((indicator) => media.includes(indicator));
};

export default function ArticleItem({
  slug,
  headline,
  summary,
  location,
  media,
  date,
}: Article) {
  const mediaIsVideo = isVideo(media);
  const humanReadableDate = new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <li>
      <article className={classes.article}>
        <header className={classes.header}>
          <Link href={`/articles/${slug}`}>
            <h2>{headline}</h2>
          </Link>
          {location && <p>{location}</p>}
          <p>{humanReadableDate}</p>
        </header>
        <hr />
        <Link href={`/articles/${slug}`}>
          <div className={classes.image}>
            {mediaIsVideo ? (
              <Video media={media} />
            ) : (
              media && <Image src={media} alt={slug} fill />
            )}
          </div>
        </Link>
        {summary && <p className={classes.summary}>{summary}</p>}
        <div className={classes.actions}>
          <Link href={`/articles/${slug}`}>View Details</Link>
        </div>
      </article>
    </li>
  );
}

import RSSParser from "rss-parser";
import type { PrismaClient, Source } from "@prisma/client";

const rssParser = new RSSParser({
  timeout: 15000,
  headers: {
    "User-Agent": "Clearfeed/1.0 (News Aggregator)",
  },
});

export interface ScrapedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date | null;
  sourceId: string;
  // v2 fields
  author?: string | null;
  tags?: string[];
  guid?: string | null;
}

/**
 * Scrapes all active sources for a given user.
 * Returns new articles (deduped against existing DB entries).
 */
export async function scrapeUserSources(
  prisma: PrismaClient,
  userId: string
): Promise<{ articles: ScrapedArticle[]; errors: string[] }> {
  const sources = await prisma.source.findMany({
    where: { userId, active: true },
  });

  if (sources.length === 0) {
    return { articles: [], errors: [] };
  }

  const allArticles: ScrapedArticle[] = [];
  const errors: string[] = [];

  // Scrape each source, don't let one failure kill the whole batch
  for (const source of sources) {
    try {
      const articles = await scrapeSource(source);
      allArticles.push(...articles);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`[${source.name}] ${message}`);
      console.error(`Scraper error for source "${source.name}" (${source.url}):`, message);
    }
  }

  // Deduplicate against articles this USER already has (not global)
  const existingUrls = new Set(
    (
      await prisma.userArticle.findMany({
        where: {
          userId,
          article: { url: { in: allArticles.map((a) => a.url) } },
        },
        include: { article: { select: { url: true } } },
      })
    ).map((ua) => ua.article.url)
  );

  const newArticles = allArticles.filter((a) => !existingUrls.has(a.url));

  console.log(
    `Scraped ${allArticles.length} total articles, ${newArticles.length} new for user, ${errors.length} errors`
  );

  return { articles: newArticles, errors };
}

/**
 * Scrapes a single source based on its type (RSS or WEBSITE).
 */
async function scrapeSource(source: Source): Promise<ScrapedArticle[]> {
  if (source.type === "RSS") {
    return scrapeRSS(source);
  }
  return scrapeWebsite(source);
}

/**
 * Parses an RSS feed and extracts articles from the last 24 hours.
 */
async function scrapeRSS(source: Source): Promise<ScrapedArticle[]> {
  const feed = await rssParser.parseURL(source.url);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const articles: ScrapedArticle[] = [];

  for (const item of feed.items) {
    if (!item.title || !item.link) continue;

    const publishedAt = item.pubDate ? new Date(item.pubDate) : null;

    // Skip articles older than 7 days (if we can determine the date)
    if (publishedAt && publishedAt < sevenDaysAgo) continue;

    const content =
      item.contentSnippet ||
      item.content ||
      item.summary ||
      item.title;

    articles.push({
      title: item.title.trim(),
      url: item.link.trim(),
      content: stripHtml(content).slice(0, 5000), // Cap content length
      publishedAt,
      sourceId: source.id,
      author: (item.creator as string) || (item.author as string) || null,
      tags: (item.categories as string[]) || [],
      guid: (item.guid as string) || null,
    });
  }

  return articles;
}

/**
 * Basic website scraping — fetches the page and extracts text.
 * For v1 this is a simple fallback; RSS is the primary source type.
 */
async function scrapeWebsite(source: Source): Promise<ScrapedArticle[]> {
  const response = await fetch(source.url, {
    headers: { "User-Agent": "Clearfeed/1.0 (News Aggregator)" },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const text = stripHtml(html).slice(0, 5000);

  // For websites, we treat the whole page as one "article"
  return [
    {
      title: source.name,
      url: source.url,
      content: text,
      publishedAt: new Date(),
      sourceId: source.id,
    },
  ];
}

/**
 * Strips HTML tags from a string.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

import RSSParser from "rss-parser";
import type { PrismaClient, Source } from "@prisma/client";

const rssParser = new RSSParser({
  timeout: 15000,
  headers: {
    "User-Agent": "Clearfeed/1.0 (News Aggregator)",
  },
});

// ── In-memory feed cache: avoid re-fetching the same RSS URL within 1 hour ──
interface CachedFeed {
  articles: ScrapedArticle[];
  timestamp: number;
}
const feedCache = new Map<string, CachedFeed>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

  // Scrape all sources in parallel — each has its own timeout so one slow feed won't block others
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      try {
        return { source, articles: await scrapeSource(source) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw { source, message };
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value.articles);
    } else {
      const { source, message } = result.reason as { source: Source; message: string };
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
  const now = Date.now();
  const cached = feedCache.get(source.url);

  // Return cached articles (re-tagged with this source's ID)
  if (cached && now - cached.timestamp < CACHE_TTL) {
    console.log(`[Cache HIT] ${source.url}`);
    return cached.articles.map((a) => ({ ...a, sourceId: source.id }));
  }

  console.log(`[Cache MISS] ${source.url}`);
  const feed = await rssParser.parseURL(source.url);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

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

  // Store in cache for other users with the same source URL
  feedCache.set(source.url, { articles, timestamp: now });
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
 * Pre-warms the feed cache by scraping all unique RSS sources for a batch of users.
 * Call before running per-user digests so all subsequent scrapeUserSources() calls hit cache.
 */
export async function prewarmFeedCache(
  prisma: PrismaClient,
  userIds: string[]
): Promise<void> {
  const sources = await prisma.source.findMany({
    where: { userId: { in: userIds }, active: true, type: "RSS" },
    select: { url: true, id: true },
  });

  // Dedupe by URL — different users may have Source records with the same URL
  const seen = new Set<string>();
  const uniqueSources = sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  console.log(
    `[Pre-warm] Scraping ${uniqueSources.length} unique RSS feeds for ${userIds.length} users...`
  );

  const results = await Promise.allSettled(
    uniqueSources.map(async (source) => {
      try {
        await scrapeRSS(source as Source);
      } catch (err) {
        console.error(
          `[Pre-warm] Failed ${source.url}:`,
          err instanceof Error ? err.message : err
        );
      }
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  console.log(`[Pre-warm] Cache ready — ${succeeded}/${uniqueSources.length} feeds cached.`);
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

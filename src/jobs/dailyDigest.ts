import type { PrismaClient } from "@prisma/client";
import { scrapeUserSources } from "../services/scraper.js";
import { matchArticles, getUserKeywords } from "../services/matcher.js";
import { summarizeArticle } from "../services/summarizer.js";
import { runDigestForUserV2 } from "./dailyDigestV2.js";

/**
 * Runs the digest pipeline for a single user.
 * Dispatches to v2 pipeline for onboarded users, v1 for others.
 */
export async function runDigestForUser(
  prisma: PrismaClient,
  userId: string
): Promise<DigestResult> {
  // Check if user is onboarded → use v2 pipeline
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboarded: true, industryId: true },
  });

  if (user?.onboarded && user?.industryId) {
    console.log(`[Digest] User ${userId}: Using v2 pipeline (onboarded)`);
    return runDigestForUserV2(prisma, userId);
  }

  return runDigestForUserV1(prisma, userId);
}

/**
 * V1 digest pipeline (original):
 * 1. Scrape their sources
 * 2. Match articles against their keywords
 * 3. Summarize matched articles with AI
 * 4. Store everything in the database
 */
async function runDigestForUserV1(
  prisma: PrismaClient,
  userId: string
): Promise<DigestResult> {
  const startTime = Date.now();
  const result: DigestResult = {
    userId,
    scraped: 0,
    matched: 0,
    summarized: 0,
    errors: [],
  };

  try {
    // Step 1: Scrape all active sources for this user
    console.log(`[Digest] User ${userId}: Starting scrape...`);
    const { articles: scrapedArticles, errors: scrapeErrors } =
      await scrapeUserSources(prisma, userId);
    result.scraped = scrapedArticles.length;
    result.errors.push(...scrapeErrors);

    // Re-match all articles against current keywords (catches new keywords)
    const rematched = await rematchArticles(prisma, userId);
    result.matched += rematched.matched;
    result.summarized += rematched.summarized;

    if (scrapedArticles.length === 0) {
      console.log(`[Digest] User ${userId}: No new articles found, checking unsummarized...`);
      // Retry summarization for matched articles with no summary
      const retried = await retrySummarization(prisma, userId);
      result.summarized += retried;
      return result;
    }

    // Step 2: Get user's keywords and match articles
    console.log(`[Digest] User ${userId}: Matching ${scrapedArticles.length} articles...`);
    const keywords = await getUserKeywords(prisma, userId);
    const matchResults = matchArticles(scrapedArticles, keywords);
    const matchedResults = matchResults.filter((r) => r.matched);
    result.matched = matchedResults.length;

    // Step 3: Store articles and create UserArticle links
    for (const matchResult of matchResults) {
      try {
        // Try to find existing article (may have been scraped by another user)
        let article = await prisma.article.findUnique({
          where: { url: matchResult.article.url },
        });

        if (!article) {
          // New article — create it
          article = await prisma.article.create({
            data: {
              title: matchResult.article.title,
              url: matchResult.article.url,
              content: matchResult.article.content,
              publishedAt: matchResult.article.publishedAt,
              sourceId: matchResult.article.sourceId,
            },
          });
        }

        // Step 4: If matched, summarize and create UserArticle
        if (matchResult.matched) {
          // Only summarize if article doesn't have a summary yet
          if (!article.summary) {
            console.log(
              `[Digest] User ${userId}: Summarizing "${matchResult.article.title}"...`
            );

            const summary = await summarizeArticle(
              matchResult.article.title,
              matchResult.article.content
            );

            if (summary) {
              await prisma.article.update({
                where: { id: article.id },
                data: { summary },
              });
              result.summarized++;
            }
          }

          // Create the UserArticle link (matched)
          await prisma.userArticle.create({
            data: {
              userId,
              articleId: article.id,
              matched: true,
              matchedKeywords: matchResult.matchedKeywords,
            },
          });
        } else {
          // Store unmatched articles too (for archive/future matching)
          await prisma.userArticle.create({
            data: {
              userId,
              articleId: article.id,
              matched: false,
              matchedKeywords: [],
            },
          });
        }
      } catch (err) {
        if (isDuplicateError(err)) {
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`[Article: ${matchResult.article.title}] ${message}`);
        console.error(`[Digest] Error storing article:`, message);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`[Fatal] ${message}`);
    console.error(`[Digest] Fatal error for user ${userId}:`, message);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[Digest] User ${userId}: Done in ${duration}s — ` +
      `${result.scraped} scraped, ${result.matched} matched, ` +
      `${result.summarized} summarized, ${result.errors.length} errors`
  );

  return result;
}

/**
 * Runs the digest pipeline for ALL active users.
 */
export async function runDigestForAllUsers(prisma: PrismaClient): Promise<DigestResult[]> {
  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  });

  console.log(`[Digest] Running digest for ${users.length} users...`);

  const results: DigestResult[] = [];

  for (const user of users) {
    console.log(`[Digest] Processing user: ${user.email}`);
    const result = await runDigestForUser(prisma, user.id);
    results.push(result);
  }

  const totalMatched = results.reduce((sum, r) => sum + r.matched, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  console.log(
    `[Digest] All users done — ${totalMatched} total matched articles, ${totalErrors} total errors`
  );

  return results;
}

export interface DigestResult {
  userId: string;
  scraped: number;
  matched: number;
  summarized: number;
  errors: string[];
}

/**
 * Retries summarization for matched articles that have no summary yet.
 * This handles cases where the API key was missing on first run.
 */
async function retrySummarization(
  prisma: PrismaClient,
  userId: string
): Promise<number> {
  const unsummarized = await prisma.userArticle.findMany({
    where: { userId, matched: true, article: { summary: null } },
    include: { article: true },
  });

  if (unsummarized.length === 0) return 0;

  console.log(`[Digest] Retrying summarization for ${unsummarized.length} articles...`);
  let count = 0;

  for (const ua of unsummarized) {
    const summary = await summarizeArticle(ua.article.title, ua.article.content);
    if (summary) {
      await prisma.article.update({
        where: { id: ua.article.id },
        data: { summary },
      });
      count++;
    }
  }

  console.log(`[Digest] Retry summarized ${count}/${unsummarized.length} articles.`);
  return count;
}

/**
 * Re-checks ALL user articles against current keywords.
 * - Unmatched articles: if they now match, flip to matched + summarize
 * - Already matched articles: update their matchedKeywords with any new matches
 */
async function rematchArticles(
  prisma: PrismaClient,
  userId: string
): Promise<{ matched: number; summarized: number }> {
  const keywords = await getUserKeywords(prisma, userId);
  if (keywords.length === 0) return { matched: 0, summarized: 0 };

  // Get ALL UserArticles for this user
  const allUserArticles = await prisma.userArticle.findMany({
    where: { userId },
    include: { article: true },
  });

  if (allUserArticles.length === 0) return { matched: 0, summarized: 0 };

  const articles = allUserArticles.map((ua) => ({
    title: ua.article.title,
    url: ua.article.url,
    content: ua.article.content,
    publishedAt: ua.article.publishedAt,
    sourceId: ua.article.sourceId,
  }));

  const matchResults = matchArticles(articles, keywords);
  let newlyMatchedCount = 0;
  let summarizedCount = 0;

  for (let i = 0; i < matchResults.length; i++) {
    const mr = matchResults[i];
    const ua = allUserArticles[i];

    if (!mr.matched) continue;

    // Check if keywords changed (new keywords matched)
    const oldKeywords = (ua.matchedKeywords as string[]) || [];
    const newKeywords = mr.matchedKeywords.sort();
    const keywordsChanged =
      oldKeywords.length !== newKeywords.length ||
      oldKeywords.sort().join(",") !== newKeywords.join(",");

    if (!ua.matched) {
      // Previously unmatched → now matched
      console.log(`[Digest] Re-matched: "${ua.article.title}" with keywords: [${mr.matchedKeywords.join(", ")}]`);
      await prisma.userArticle.update({
        where: { id: ua.id },
        data: { matched: true, matchedKeywords: mr.matchedKeywords },
      });
      newlyMatchedCount++;

      // Summarize if no summary exists
      if (!ua.article.summary) {
        const summary = await summarizeArticle(ua.article.title, ua.article.content);
        if (summary) {
          await prisma.article.update({
            where: { id: ua.article.id },
            data: { summary },
          });
          summarizedCount++;
        }
      }
    } else if (keywordsChanged) {
      // Already matched but has new keyword matches → update keywords
      console.log(`[Digest] Updated keywords for: "${ua.article.title}" → [${mr.matchedKeywords.join(", ")}]`);
      await prisma.userArticle.update({
        where: { id: ua.id },
        data: { matchedKeywords: mr.matchedKeywords },
      });
    }
  }

  if (newlyMatchedCount > 0) {
    console.log(`[Digest] Re-matched ${newlyMatchedCount} old articles, summarized ${summarizedCount}`);
  }

  return { matched: newlyMatchedCount, summarized: summarizedCount };
}

function isDuplicateError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("Unique constraint failed")
  );
}

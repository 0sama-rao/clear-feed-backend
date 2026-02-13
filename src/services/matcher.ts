import type { PrismaClient } from "@prisma/client";
import type { ScrapedArticle } from "./scraper.js";

export interface MatchResult {
  article: ScrapedArticle;
  matched: boolean;
  matchedKeywords: string[];
}

/**
 * Matches scraped articles against a user's keywords.
 * Checks both title and content for keyword presence (case-insensitive).
 */
export function matchArticles(
  articles: ScrapedArticle[],
  keywords: string[]
): MatchResult[] {
  if (keywords.length === 0 || articles.length === 0) {
    return articles.map((article) => ({
      article,
      matched: false,
      matchedKeywords: [],
    }));
  }

  // Pre-compile keyword patterns for performance
  const keywordPatterns = keywords.map((kw) => ({
    word: kw,
    regex: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i"),
  }));

  return articles.map((article) => {
    const searchText = `${article.title} ${article.content}`;
    const matchedKeywords: string[] = [];

    for (const { word, regex } of keywordPatterns) {
      if (regex.test(searchText)) {
        matchedKeywords.push(word);
      }
    }

    return {
      article,
      matched: matchedKeywords.length > 0,
      matchedKeywords,
    };
  });
}

/**
 * Loads a user's keywords from the database.
 */
export async function getUserKeywords(
  prisma: PrismaClient,
  userId: string
): Promise<string[]> {
  const keywords = await prisma.keyword.findMany({
    where: { userId },
    select: { word: true },
  });
  return keywords.map((k) => k.word);
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

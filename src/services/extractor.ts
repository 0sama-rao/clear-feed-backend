export interface ExtractedContent {
  cleanText: string;
  rawHtml: string;
  externalLinks: string[];
  author: string | null;
}

/**
 * Fetches full article content from a URL, extracts the main body text,
 * and finds outbound links. Returns null on failure (pipeline continues
 * with RSS snippet as fallback).
 */
export async function extractArticleContent(
  url: string
): Promise<ExtractedContent | null> {
  try {
    // Fetch raw HTML first
    const response = await fetch(url, {
      headers: { "User-Agent": "Clearfeed/1.0 (News Aggregator)" },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.error(`[Extractor] HTTP ${response.status} for ${url}`);
      return null;
    }

    const rawHtml = (await response.text()).slice(0, 500_000); // Cap at 500KB

    // Dynamic import for ESM-only package
    const { extractFromHtml } = await import("@extractus/article-extractor");
    const article = await extractFromHtml(rawHtml, url);

    if (!article || !article.content) {
      console.error(`[Extractor] No content extracted from ${url}`);
      return null;
    }

    // Clean the extracted HTML to plain text
    const cleanText = stripHtml(article.content).slice(0, 15_000);

    // Extract external links from the raw HTML
    const externalLinks = extractLinks(rawHtml, url);

    return {
      cleanText,
      rawHtml,
      externalLinks,
      author: article.author || null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Extractor] Failed for ${url}:`, message);
    return null;
  }
}

/**
 * Extracts outbound links from HTML, filtering to external domains.
 */
function extractLinks(html: string, sourceUrl: string): string[] {
  const links: string[] = [];
  let sourceDomain: string;
  try {
    sourceDomain = new URL(sourceUrl).hostname;
  } catch {
    return [];
  }

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const linkUrl = new URL(match[1], sourceUrl);
      if (
        linkUrl.protocol.startsWith("http") &&
        linkUrl.hostname !== sourceDomain
      ) {
        links.push(linkUrl.href);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  // Deduplicate
  return [...new Set(links)].slice(0, 50);
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

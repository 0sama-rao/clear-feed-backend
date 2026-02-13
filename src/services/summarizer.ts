import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generates a 2-3 sentence summary of an article using OpenAI.
 * Handles errors gracefully — returns null if summarization fails.
 */
export async function summarizeArticle(
  title: string,
  content: string
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Summarizer: OPENAI_API_KEY is not set, skipping summarization");
    return null;
  }

  try {
    // Truncate content to avoid token limits
    const truncatedContent = content.slice(0, 3000);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a news summarizer. Given an article title and content, write a concise 2-3 sentence summary. Focus on the key facts and why it matters. Be direct and informative.",
        },
        {
          role: "user",
          content: `Title: ${title}\n\nContent: ${truncatedContent}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const summary = response.choices[0]?.message?.content?.trim();

    if (!summary) {
      console.error(`Summarizer: Empty response for article "${title}"`);
      return null;
    }

    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Summarizer error for "${title}":`, message);
    return null;
  }
}

/**
 * Summarizes multiple articles with a delay between calls to respect rate limits.
 */
export async function summarizeArticles(
  articles: Array<{ title: string; content: string }>
): Promise<Array<string | null>> {
  const summaries: Array<string | null> = [];

  for (const article of articles) {
    const summary = await summarizeArticle(article.title, article.content);
    summaries.push(summary);

    // Small delay between calls to avoid rate limiting
    if (articles.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return summaries;
}

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generates a top-level executive summary across all news groups for the day.
 * Returns 5-10 bullet points covering the most important developments.
 */
export async function generateExecutiveSummary(
  groups: Array<{ title: string; synopsis: string; signals: string[] }>
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[ExecSummary] OPENAI_API_KEY is not set, skipping");
    return null;
  }

  if (groups.length === 0) return null;

  try {
    const groupSummaries = groups
      .map(
        (g, i) =>
          `${i + 1}. ${g.title}\nSignals: ${g.signals.join(", ") || "None"}\n${g.synopsis}`
      )
      .join("\n\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a senior cybersecurity intelligence analyst. Given today's story groups and their synopses, produce a concise executive summary as 5-10 bullet points.

Each bullet should:
- Be one clear sentence
- Cover a distinct development or theme
- Prioritize the most impactful stories first

Format as a markdown bulleted list (- bullet). Return ONLY the bullet list, no preamble.`,
        },
        {
          role: "user",
          content: `Today's intelligence groups:\n\n${groupSummaries}`,
        },
      ],
      max_tokens: 800,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.error("[ExecSummary] Empty response");
      return null;
    }

    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ExecSummary] Error:", message);
    return null;
  }
}

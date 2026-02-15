import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ExtractedEntity {
  name: string;
  confidence: number;
}

export interface ExtractedSignal {
  slug: string;
  confidence: number;
}

export interface ExtractedEntities {
  companies: ExtractedEntity[];
  people: ExtractedEntity[];
  products: ExtractedEntity[];
  geographies: ExtractedEntity[];
  sectors: ExtractedEntity[];
  signals: ExtractedSignal[];
}

/**
 * Uses OpenAI to extract structured entities and classify industry signals
 * from an article's title and text content.
 */
export async function extractEntities(
  title: string,
  text: string,
  industrySignalSlugs: string[]
): Promise<ExtractedEntities | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[EntityExtractor] OPENAI_API_KEY is not set, skipping");
    return null;
  }

  try {
    const truncatedText = text.slice(0, 6000);
    const signalList = industrySignalSlugs.join(", ");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a cybersecurity intelligence analyst. Extract structured entities from the following article and classify it against industry signals.

For each entity, assign a confidence score from 0.0 to 1.0 based on how prominently it features in the article.

Entity types to extract:
- companies: Organizations, companies, government agencies mentioned
- people: Named individuals mentioned
- products: Software, hardware, services, tools, platforms mentioned
- geographies: Countries, regions, cities mentioned
- sectors: Industry sectors affected (e.g., healthcare, finance, government, telecom)

Signal classification — classify this article into one or more of these signals (ONLY use slugs from this list):
${signalList}

For each signal, assign a confidence score from 0.0 to 1.0.

Return JSON with this exact structure:
{
  "companies": [{"name": "...", "confidence": 0.9}],
  "people": [{"name": "...", "confidence": 0.8}],
  "products": [{"name": "...", "confidence": 0.7}],
  "geographies": [{"name": "...", "confidence": 0.9}],
  "sectors": [{"name": "...", "confidence": 0.8}],
  "signals": [{"slug": "...", "confidence": 0.9}]
}

Return empty arrays for entity types with no matches. Only include signals with confidence >= 0.5.`,
        },
        {
          role: "user",
          content: `Title: ${title}\n\nContent: ${truncatedText}`,
        },
      ],
      max_tokens: 1000,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.error(`[EntityExtractor] Empty response for "${title}"`);
      return null;
    }

    const parsed = JSON.parse(content) as ExtractedEntities;

    // Filter entities by confidence threshold (>= 0.3)
    return {
      companies: (parsed.companies || []).filter((e) => e.confidence >= 0.3),
      people: (parsed.people || []).filter((e) => e.confidence >= 0.3),
      products: (parsed.products || []).filter((e) => e.confidence >= 0.3),
      geographies: (parsed.geographies || []).filter((e) => e.confidence >= 0.3),
      sectors: (parsed.sectors || []).filter((e) => e.confidence >= 0.3),
      signals: (parsed.signals || []).filter(
        (s) => s.confidence >= 0.5 && industrySignalSlugs.includes(s.slug)
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EntityExtractor] Error for "${title}":`, message);
    return null;
  }
}

import OpenAI from "openai";
import type { PrismaClient } from "@prisma/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface PeriodStats {
  totalStories: number;
  totalArticles: number;
  criticalStories: number;
  signalDistribution: Record<string, number>;
  topEntities: Array<{ name: string; type: string; count: number }>;
  storiesPerDay: Record<string, number>;
}

const PERIOD_DAYS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

/**
 * Generates period reports for all standard periods (1d, 7d, 30d).
 * Called after digest pipeline completes.
 */
export async function generateAllPeriodReports(
  prisma: PrismaClient,
  userId: string
): Promise<void> {
  for (const period of ["1d", "7d", "30d"]) {
    await generatePeriodReport(prisma, userId, period);
  }
}

/**
 * Generates a single period report: computes stats from DB, generates
 * AI summary, and upserts into PeriodReport table.
 */
export async function generatePeriodReport(
  prisma: PrismaClient,
  userId: string,
  period: string
): Promise<void> {
  const days = PERIOD_DAYS[period];
  if (!days) return;

  const toDate = new Date();
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Fetch all groups in the period with full data
  const groups = await prisma.newsGroup.findMany({
    where: {
      userId,
      userArticles: {
        some: {
          article: { publishedAt: { gte: fromDate } },
        },
      },
    },
    include: {
      userArticles: {
        include: {
          article: {
            include: {
              entities: { select: { type: true, name: true } },
              articleSignals: {
                include: { industrySignal: { select: { name: true, slug: true } } },
              },
            },
          },
        },
      },
    },
  });

  // Compute stats from DB data (no AI)
  const stats = computeStats(groups, fromDate, toDate);

  // Generate AI summary (one gpt-4o-mini call)
  const summary = await generatePeriodSummary(
    groups.map((g) => ({
      title: g.title,
      synopsis: g.synopsis || "",
      caseType: g.caseType,
      signals: [
        ...new Set(
          g.userArticles.flatMap((ua) =>
            ua.article.articleSignals.map((as) => as.industrySignal.name)
          )
        ),
      ],
    })),
    period
  );

  // Upsert into DB
  await prisma.periodReport.upsert({
    where: { userId_period: { userId, period } },
    update: {
      fromDate,
      toDate,
      summary,
      stats: stats as any,
      generatedAt: new Date(),
    },
    create: {
      userId,
      period,
      fromDate,
      toDate,
      summary,
      stats: stats as any,
    },
  });

  console.log(`[PeriodReport] Generated ${period} report for user ${userId}: ${stats.totalStories} stories, ${stats.totalArticles} articles`);
}

/**
 * Computes aggregate stats from groups data. Pure computation, no AI.
 */
function computeStats(
  groups: Array<{
    caseType: number | null;
    date: Date;
    userArticles: Array<{
      article: {
        entities: Array<{ type: string; name: string }>;
        articleSignals: Array<{
          industrySignal: { name: string; slug: string };
        }>;
      };
    }>;
  }>,
  fromDate: Date,
  toDate: Date
): PeriodStats {
  // Total stories
  const totalStories = groups.length;

  // Total unique articles
  const articleIds = new Set<string>();
  const signalCounts = new Map<string, number>();
  const entityCounts = new Map<string, { type: string; count: number }>();
  const dailyCounts = new Map<string, number>();

  // Initialize daily counts for the period
  const current = new Date(fromDate);
  while (current <= toDate) {
    dailyCounts.set(current.toISOString().split("T")[0], 0);
    current.setDate(current.getDate() + 1);
  }

  for (const group of groups) {
    // Stories per day
    const dayKey = group.date.toISOString().split("T")[0];
    dailyCounts.set(dayKey, (dailyCounts.get(dayKey) || 0) + 1);

    for (const ua of group.userArticles) {
      articleIds.add(ua.article.toString()); // count unique articles

      // Signal distribution
      for (const as of ua.article.articleSignals) {
        const name = as.industrySignal.name;
        signalCounts.set(name, (signalCounts.get(name) || 0) + 1);
      }

      // Entity counts
      for (const e of ua.article.entities) {
        const key = `${e.type}::${e.name}`;
        const existing = entityCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          entityCounts.set(key, { type: e.type, count: 1 });
        }
      }
    }
  }

  // Critical stories (caseType === 1)
  const criticalStories = groups.filter((g) => g.caseType === 1).length;

  // Signal distribution as object
  const signalDistribution: Record<string, number> = {};
  for (const [name, count] of [...signalCounts.entries()].sort((a, b) => b[1] - a[1])) {
    signalDistribution[name] = count;
  }

  // Top 10 entities
  const topEntities = [...entityCounts.entries()]
    .map(([key, val]) => {
      const [type, name] = key.split("::");
      return { name, type, count: val.count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Stories per day
  const storiesPerDay: Record<string, number> = {};
  for (const [day, count] of dailyCounts) {
    storiesPerDay[day] = count;
  }

  return {
    totalStories,
    totalArticles: groups.reduce((sum, g) => sum + g.userArticles.length, 0),
    criticalStories,
    signalDistribution,
    topEntities,
    storiesPerDay,
  };
}

/**
 * Generates an AI summary for the period. One gpt-4o-mini call.
 */
async function generatePeriodSummary(
  groups: Array<{
    title: string;
    synopsis: string;
    caseType: number | null;
    signals: string[];
  }>,
  period: string
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY || groups.length === 0) return null;

  const periodLabel =
    period === "1d" ? "today" : period === "7d" ? "this week" : "this month";

  const caseLabels: Record<number, string> = {
    1: "CRITICAL",
    2: "VULNERABLE",
    3: "FIXED",
    4: "INFO",
  };

  try {
    const groupSummaries = groups
      .map((g, i) => {
        const caseLabel = caseLabels[g.caseType || 4] || "INFO";
        return `${i + 1}. [${caseLabel}] ${g.title}\nSignals: ${g.signals.join(", ") || "None"}\n${g.synopsis}`;
      })
      .join("\n\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a senior cybersecurity intelligence analyst. Given the story groups from ${periodLabel}, produce a comprehensive period intelligence summary.

Structure your response as markdown with these sections:

## Key Developments
3-5 bullet points of the most significant events. Prioritize CRITICAL stories first.

## Threat Landscape
2-3 sentences on overall threat posture for the period.

## Trends
Any patterns, escalating themes, or recurring actors/signals.

## Outlook
1-2 sentences on what to watch next.

Be specific. Reference real names, CVEs, and actors from the data. Return ONLY the markdown, no preamble.`,
        },
        {
          role: "user",
          content: `Intelligence groups from ${periodLabel} (${groups.length} stories):\n\n${groupSummaries}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PeriodReport] Summary generation failed for ${period}:`, message);
    return null;
  }
}

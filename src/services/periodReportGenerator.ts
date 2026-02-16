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
    1: "CRITICAL — Actively Exploited",
    2: "VULNERABLE — No Known Exploit",
    3: "FIXED — Patched/Resolved",
    4: "INFO — Informational",
  };

  // Sort groups: critical first, then vulnerable, fixed, info
  const sorted = [...groups].sort((a, b) => (a.caseType || 4) - (b.caseType || 4));

  // Count by case type for the prompt context
  const caseCounts = {
    critical: groups.filter((g) => g.caseType === 1).length,
    vulnerable: groups.filter((g) => g.caseType === 2).length,
    fixed: groups.filter((g) => g.caseType === 3).length,
    info: groups.filter((g) => g.caseType === 4 || !g.caseType).length,
  };

  try {
    const groupSummaries = sorted
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
          content: `You are a senior cybersecurity intelligence analyst producing a ${periodLabel} intelligence report for security operations teams.

You will receive story groups classified by severity:
- **CRITICAL** (Case 1): Actively exploited vulnerabilities, ongoing attacks, confirmed campaigns with IOCs
- **VULNERABLE** (Case 2): Known vulnerabilities with no confirmed exploitation yet, pending patches
- **FIXED** (Case 3): Patched vulnerabilities, post-incident retrospectives, resolved issues
- **INFO** (Case 4): Research, policy updates, threat landscape reports, general intelligence

Period breakdown: ${caseCounts.critical} critical, ${caseCounts.vulnerable} vulnerable, ${caseCounts.fixed} fixed, ${caseCounts.info} informational (${groups.length} total stories).

Structure your response as markdown with these sections:

## Key Developments
3-5 bullet points of the most impactful events. ALWAYS lead with CRITICAL (Case 1) stories first. For each bullet:
- Name the specific threat, CVE, or actor
- State what happened and who is affected
- Mark urgency: 🔴 for critical, 🟡 for vulnerable, 🟢 for fixed, ⚪ for informational

## Threat Landscape

Break down ${periodLabel}'s threat posture by severity tier:

**Active Threats (Immediate Action Required)**
For CRITICAL stories: list each actively exploited vulnerability or ongoing attack. Include CVE IDs, affected products/versions, threat actors, and known IOCs from the data. If no critical stories exist, state "No actively exploited threats this period."

**Exposure Risks (Monitor & Prepare)**
For VULNERABLE stories: list unpatched vulnerabilities or emerging threats not yet exploited. Include affected software, available patches, and recommended SLAs. If none, state "No new unpatched exposures."

**Resolved This Period**
For FIXED stories: briefly note what was patched or resolved. Include patch versions. If none, state "No resolutions to report."

**Intelligence & Context**
For INFO stories: summarize research findings, policy changes, or threat landscape shifts that inform strategic posture.

## Trends
Identify patterns across all stories:
- Recurring threat actors, targeted sectors, or attack techniques
- Escalating signal categories (which signals are trending up)
- Any correlation between stories (same actor, same vulnerability class, same target sector)

## Recommended Actions
Prioritized action items based on the case types:
1. **Immediate** (from CRITICAL stories): specific patches, IOCs to block, services to disable — cite real names and versions
2. **This Week** (from VULNERABLE stories): patches to schedule, detection rules to deploy, monitoring to enable
3. **Review** (from FIXED/INFO stories): validations to perform, policies to update, awareness items

## Outlook
2-3 sentences on what to watch next based on the trends and unresolved threats. Reference specific actors, CVEs, or campaigns that may escalate.

IMPORTANT RULES:
- Be specific: use real CVE IDs, product names, versions, actor names, and IOCs from the provided data
- Do NOT fabricate information — only reference what appears in the story synopses
- If a section has no applicable stories, include a brief "Nothing to report" note rather than omitting it
- Return ONLY the markdown, no preamble or closing remarks`,
        },
        {
          role: "user",
          content: `Intelligence groups from ${periodLabel} (${groups.length} stories):\n\n${groupSummaries}`,
        },
      ],
      max_tokens: 2500,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PeriodReport] Summary generation failed for ${period}:`, message);
    return null;
  }
}

import OpenAI from "openai";
import type { PrismaClient } from "@prisma/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface PeriodStats {
  totalStories: number;
  totalArticles: number;
  criticalStories: number;
  vulnerableStories: number;
  fixedStories: number;
  infoStories: number;
  signalDistribution: Record<string, number>;
  topEntities: Array<{ name: string; type: string; count: number }>;
  storiesPerDay: Record<string, number>;
  topAffectedProducts: Array<{ name: string; count: number }>;
  topAffectedSectors: Array<{ name: string; count: number }>;
  topThreatActors: Array<{ name: string; count: number }>;
  // CVE metrics
  uniqueCVEs: number;
  criticalCVEs: number;
  highCVEs: number;
  mediumCVEs: number;
  lowCVEs: number;
  kevCount: number;
  avgCVSS: number | null;
  maxCVSS: number | null;
  topCVEs: Array<{ cveId: string; cvssScore: number | null; severity: string | null; inKEV: boolean; articleCount: number }>;
  kevCVEs: Array<{ cveId: string; cvssScore: number | null; kevDueDate: Date | null }>;
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
              cves: {
                select: { cveId: true, cvssScore: true, severity: true, inKEV: true, kevDueDate: true, description: true },
              },
            },
          },
        },
      },
    },
  });

  // Compute stats from DB data (no AI)
  const stats = computeStats(groups, fromDate, toDate);

  // Build group data for AI prompt
  const groupData = groups.map((g) => ({
    title: g.title,
    synopsis: g.synopsis || "",
    executiveSummary: g.executiveSummary || "",
    impactAnalysis: g.impactAnalysis || "",
    actionability: g.actionability || "",
    caseType: g.caseType,
    articleCount: g.userArticles.length,
    signals: [
      ...new Set(
        g.userArticles.flatMap((ua) =>
          ua.article.articleSignals.map((as) => as.industrySignal.name)
        )
      ),
    ],
    entities: [
      ...new Set(
        g.userArticles.flatMap((ua) =>
          ua.article.entities.map((e) => `${e.type}: ${e.name}`)
        )
      ),
    ].slice(0, 15),
    cves: [
      ...new Map(
        g.userArticles.flatMap((ua) =>
          ua.article.cves.map((c) => [c.cveId, { cveId: c.cveId, cvssScore: c.cvssScore, severity: c.severity, inKEV: c.inKEV }] as const)
        )
      ).values(),
    ],
  }));

  // Generate AI summary with period-specific prompt
  const summary = await generatePeriodSummary(groupData, period, stats);

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
        cves: Array<{ cveId: string; cvssScore: number | null; severity: string | null; inKEV: boolean; kevDueDate: Date | null }>;
      };
    }>;
  }>,
  fromDate: Date,
  toDate: Date
): PeriodStats {
  const totalStories = groups.length;
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
    const dayKey = group.date.toISOString().split("T")[0];
    dailyCounts.set(dayKey, (dailyCounts.get(dayKey) || 0) + 1);

    for (const ua of group.userArticles) {
      for (const as of ua.article.articleSignals) {
        const name = as.industrySignal.name;
        signalCounts.set(name, (signalCounts.get(name) || 0) + 1);
      }

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

  // Case type counts
  const criticalStories = groups.filter((g) => g.caseType === 1).length;
  const vulnerableStories = groups.filter((g) => g.caseType === 2).length;
  const fixedStories = groups.filter((g) => g.caseType === 3).length;
  const infoStories = groups.filter((g) => g.caseType === 4 || !g.caseType).length;

  // Signal distribution
  const signalDistribution: Record<string, number> = {};
  for (const [name, count] of [...signalCounts.entries()].sort((a, b) => b[1] - a[1])) {
    signalDistribution[name] = count;
  }

  // Top entities by type
  const allEntities = [...entityCounts.entries()]
    .map(([key, val]) => {
      const [type, name] = key.split("::");
      return { name, type, count: val.count };
    })
    .sort((a, b) => b.count - a.count);

  const topEntities = allEntities.slice(0, 10);
  const topAffectedProducts = allEntities
    .filter((e) => e.type === "PRODUCT")
    .slice(0, 10);
  const topAffectedSectors = allEntities
    .filter((e) => e.type === "SECTOR")
    .slice(0, 10);
  const topThreatActors = allEntities
    .filter((e) => e.type === "PERSON" || e.type === "COMPANY")
    .slice(0, 10);

  // Stories per day
  const storiesPerDay: Record<string, number> = {};
  for (const [day, count] of dailyCounts) {
    storiesPerDay[day] = count;
  }

  // CVE aggregation
  const cveMap = new Map<string, { cvssScore: number | null; severity: string | null; inKEV: boolean; kevDueDate: Date | null; articleCount: number }>();
  for (const group of groups) {
    for (const ua of group.userArticles) {
      for (const cve of ua.article.cves) {
        const existing = cveMap.get(cve.cveId);
        if (existing) {
          existing.articleCount++;
        } else {
          cveMap.set(cve.cveId, {
            cvssScore: cve.cvssScore,
            severity: cve.severity,
            inKEV: cve.inKEV,
            kevDueDate: cve.kevDueDate,
            articleCount: 1,
          });
        }
      }
    }
  }

  const allCVEs = [...cveMap.entries()];
  const scores = allCVEs.filter(([_, c]) => c.cvssScore !== null).map(([_, c]) => c.cvssScore!);

  const uniqueCVEs = allCVEs.length;
  const criticalCVECount = allCVEs.filter(([_, c]) => c.cvssScore !== null && c.cvssScore >= 9.0).length;
  const highCVECount = allCVEs.filter(([_, c]) => c.cvssScore !== null && c.cvssScore >= 7.0 && c.cvssScore < 9.0).length;
  const mediumCVECount = allCVEs.filter(([_, c]) => c.cvssScore !== null && c.cvssScore >= 4.0 && c.cvssScore < 7.0).length;
  const lowCVECount = allCVEs.filter(([_, c]) => c.cvssScore !== null && c.cvssScore < 4.0).length;
  const kevCount = allCVEs.filter(([_, c]) => c.inKEV).length;
  const avgCVSS = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const maxCVSS = scores.length > 0 ? Math.max(...scores) : null;

  const topCVEs = allCVEs
    .sort((a, b) => (b[1].cvssScore ?? 0) - (a[1].cvssScore ?? 0))
    .slice(0, 10)
    .map(([cveId, data]) => ({
      cveId,
      cvssScore: data.cvssScore,
      severity: data.severity,
      inKEV: data.inKEV,
      articleCount: data.articleCount,
    }));

  const kevCVEs = allCVEs
    .filter(([_, c]) => c.inKEV)
    .map(([cveId, data]) => ({
      cveId,
      cvssScore: data.cvssScore,
      kevDueDate: data.kevDueDate,
    }));

  return {
    totalStories,
    totalArticles: groups.reduce((sum, g) => sum + g.userArticles.length, 0),
    criticalStories,
    vulnerableStories,
    fixedStories,
    infoStories,
    signalDistribution,
    topEntities,
    storiesPerDay,
    topAffectedProducts,
    topAffectedSectors,
    topThreatActors,
    uniqueCVEs,
    criticalCVEs: criticalCVECount,
    highCVEs: highCVECount,
    mediumCVEs: mediumCVECount,
    lowCVEs: lowCVECount,
    kevCount,
    avgCVSS,
    maxCVSS,
    topCVEs,
    kevCVEs,
  };
}

// ── Period-specific prompt builders ──

interface GroupInput {
  title: string;
  synopsis: string;
  executiveSummary: string;
  impactAnalysis: string;
  actionability: string;
  caseType: number | null;
  articleCount: number;
  signals: string[];
  entities: string[];
  cves: Array<{ cveId: string; cvssScore: number | null; severity: string | null; inKEV: boolean }>;
}

const CASE_LABELS: Record<number, string> = {
  1: "CRITICAL — Actively Exploited",
  2: "VULNERABLE — No Known Exploit",
  3: "FIXED — Patched/Resolved",
  4: "INFO — Informational",
};

function buildGroupContext(groups: GroupInput[]): string {
  const sorted = [...groups].sort((a, b) => (a.caseType || 4) - (b.caseType || 4));

  const groupSummaries = sorted
    .map((g, i) => {
      const caseLabel = CASE_LABELS[g.caseType || 4] || "INFO";
      const cveStr = g.cves.length > 0
        ? g.cves.map((c) => `${c.cveId} (CVSS:${c.cvssScore ?? "?"}, ${c.severity ?? "?"}${c.inKEV ? ", KEV" : ""})`).join(", ")
        : "None";
      const parts = [
        `--- Story ${i + 1} [${caseLabel}] (${g.articleCount} articles) ---`,
        `Title: ${g.title}`,
        `Signals: ${g.signals.join(", ") || "None"}`,
        `Entities: ${g.entities.join(", ") || "None"}`,
        `CVEs: ${cveStr}`,
        `\nSynopsis:\n${g.synopsis}`,
      ];
      if (g.executiveSummary) parts.push(`\nKey Facts:\n${g.executiveSummary}`);
      if (g.impactAnalysis) parts.push(`\nImpact Analysis:\n${g.impactAnalysis}`);
      if (g.actionability) parts.push(`\nRecommended Actions:\n${g.actionability}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return groupSummaries.length > 30_000
    ? groupSummaries.slice(0, 30_000) + "\n\n[... truncated for length]"
    : groupSummaries;
}

function buildDailyPrompt(groups: GroupInput[], stats: PeriodStats): string {
  const allSignals = [...new Set(groups.flatMap((g) => g.signals))].join(", ");

  return `You are a senior cybersecurity intelligence analyst producing a DAILY OPERATIONAL BRIEFING for SOC analysts, vulnerability management, and infrastructure operations teams.

Audience: Security Operations Center, Vulnerability Management, Infrastructure Ops
Focus: What needs immediate attention TODAY

You will receive full briefings for each story group. Use ALL data to produce a focused, action-oriented daily summary.

## INPUT DATA CONTEXT
- ${stats.totalStories} stories today (${stats.totalArticles} articles)
- Severity breakdown: ${stats.criticalStories} critical, ${stats.vulnerableStories} vulnerable, ${stats.fixedStories} fixed, ${stats.infoStories} informational
- Active signals: ${allSignals || "None"}
- Top affected products: ${stats.topAffectedProducts.map((p) => p.name).join(", ") || "None identified"}
- Top affected sectors: ${stats.topAffectedSectors.map((s) => s.name).join(", ") || "None identified"}
- CVE Intelligence: ${stats.uniqueCVEs} unique CVEs mentioned, ${stats.criticalCVEs} critical (CVSS>=9.0), ${stats.highCVEs} high (CVSS>=7.0), ${stats.kevCount} on CISA KEV
- Highest CVSS: ${stats.maxCVSS ?? "N/A"}, Average CVSS: ${stats.avgCVSS?.toFixed(1) ?? "N/A"}${stats.kevCVEs.length > 0 ? `\n- CISA KEV CVEs requiring action: ${stats.kevCVEs.map((k) => k.cveId).join(", ")}` : ""}

## OUTPUT STRUCTURE (return markdown)

### Executive Snapshot

A 3-5 line summary paragraph covering: How many new stories, what's critical, what needs action NOW. Lead with the most urgent item.

### Critical Alerts

For each CRITICAL (Case 1) story:
- 🔴 **[Title]** — What happened, CVE IDs if available, affected products/versions, who is at risk
- **Immediate Action:** Exact steps (patch to version X, block IOC Y, disable service Z)

If no critical stories: "No actively exploited threats detected today."

### New Vulnerabilities

For each VULNERABLE (Case 2) story:
- 🟡 **[Title]** — CVE ID, affected software/versions, exploitation complexity, patch availability
- **Action:** Schedule patch, add detection rule, monitor for exploitation

If none: "No new unpatched vulnerabilities today."

### Resolved / Patched

For each FIXED (Case 3) story:
- 🟢 **[Title]** — What was fixed, which version resolves it
- **Action:** Validate patch deployment, close tickets

If none: "No resolutions to report."

### Intelligence Notes

For INFO (Case 4) stories — 1-2 lines each:
- ⚪ **[Title]** — Key takeaway and relevance

### Today's Action Checklist

A numbered list of SPECIFIC actions, ordered by urgency:
1. [URGENT] Patch X to version Y (CVE-XXXX-XXXXX)
2. [URGENT] Block IOC: ...
3. [HIGH] Schedule patching for ...
4. [MEDIUM] Review ...
5. [LOW] Awareness: ...

CRITICAL RULES:
- Use REAL CVE IDs, product names, versions, and IOCs from the briefing data
- Do NOT fabricate or hallucinate — only reference what appears in the story data
- This is an OPERATIONAL daily brief — be specific, concise, actionable
- No filler text or generic advice. Every line should reference real data
- Return ONLY the markdown, no preamble or closing remarks`;
}

function buildWeeklyPrompt(groups: GroupInput[], stats: PeriodStats): string {
  const allSignals = [...new Set(groups.flatMap((g) => g.signals))].join(", ");
  const signalBreakdown = Object.entries(stats.signalDistribution)
    .slice(0, 8)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");

  return `You are a senior cybersecurity intelligence analyst producing a WEEKLY TACTICAL INTELLIGENCE REPORT for security leadership and IT managers.

Audience: CISO, Security Leadership, IT Managers
Focus: Trends, threat posture shifts, and tactical priorities for the week

You will receive full briefings for each story group this week. Synthesize them into a tactical trend analysis.

## INPUT DATA CONTEXT
- ${stats.totalStories} stories this week (${stats.totalArticles} articles)
- Severity: ${stats.criticalStories} critical, ${stats.vulnerableStories} vulnerable, ${stats.fixedStories} fixed, ${stats.infoStories} informational
- Signal distribution: ${signalBreakdown || "None"}
- Active signals: ${allSignals || "None"}
- Top products mentioned: ${stats.topAffectedProducts.map((p) => `${p.name} (${p.count})`).join(", ") || "None"}
- Top sectors affected: ${stats.topAffectedSectors.map((s) => `${s.name} (${s.count})`).join(", ") || "None"}
- CVE Summary: ${stats.uniqueCVEs} unique CVEs, ${stats.criticalCVEs} critical, ${stats.highCVEs} high, ${stats.kevCount} CISA KEV listed
- Average CVSS: ${stats.avgCVSS?.toFixed(1) ?? "N/A"}, Peak CVSS: ${stats.maxCVSS ?? "N/A"}
- Top CVEs: ${stats.topCVEs.slice(0, 5).map((c) => `${c.cveId} (CVSS ${c.cvssScore}${c.inKEV ? ", KEV" : ""})`).join(", ") || "None"}

## OUTPUT STRUCTURE (return markdown)

### Weekly Risk Overview

| Metric | Value |
|---|---|
| Total Stories | ${stats.totalStories} |
| Critical (Actively Exploited) | ${stats.criticalStories} |
| Vulnerable (Unpatched) | ${stats.vulnerableStories} |
| Fixed / Resolved | ${stats.fixedStories} |
| Informational | ${stats.infoStories} |
| Total Articles Analyzed | ${stats.totalArticles} |
| Unique CVEs Identified | ${stats.uniqueCVEs} |
| Critical CVEs (CVSS >= 9.0) | ${stats.criticalCVEs} |
| High CVEs (CVSS >= 7.0) | ${stats.highCVEs} |
| CISA KEV Listed | ${stats.kevCount} |
| Average CVSS Score | ${stats.avgCVSS?.toFixed(1) ?? "N/A"} |

### Key Developments This Week

3-5 bullet points of the most significant events, ordered by severity:
- 🔴/🟡/🟢/⚪ **[Title]** — What happened, who is affected, why it matters this week
- Include CVE IDs, affected products/versions where available

### Exposure Summary

**Active Threats (Immediate Action Required)**
For CRITICAL stories: name the threat, CVEs, affected products, versions, attack vectors, IOCs. What must be done NOW.

**Open Exposures (Monitor & Prepare)**
For VULNERABLE stories: what's exposed, patch status, exploitation likelihood. What to schedule this week.

**Resolved This Week**
For FIXED stories: what was patched, validation steps needed.

### Thematic Trends

Analyze patterns across ALL stories this week. Identify 2-4 themes, for example:
- "Edge Infrastructure Targeting Increasing" — X VPN-related stories, Y exploited within 48h
- "Ransomware Activity Shifting to [Sector]" — pattern across incidents
- "Supply Chain Risks in [Technology]" — recurring dependency issues

For each theme: cite the specific stories and data points that support it.

### Risk Area Assessment

Based on the stories this week, assess risk posture changes:

| Risk Area | Trend | Notes |
|---|---|---|
| Perimeter / Edge Devices | ↑ / ↓ / Stable | Brief explanation |
| Identity & Access | ↑ / ↓ / Stable | Brief explanation |
| Cloud Infrastructure | ↑ / ↓ / Stable | Brief explanation |
| Application / Libraries | ↑ / ↓ / Stable | Brief explanation |
| Supply Chain | ↑ / ↓ / Stable | Brief explanation |

Only include risk areas that are relevant to this week's data. Use ↑ for increased risk, ↓ for decreased, Stable if unchanged.

### Recommended Actions

Prioritized action items synthesized from all stories:

**Immediate (24-48h)**
- Specific patches, IOC blocks, service restrictions from CRITICAL stories

**This Week**
- Patches to schedule, detection rules to deploy, configurations to review from VULNERABLE stories

**Review & Awareness**
- Post-patch validations, policy reviews, team briefing items from FIXED/INFO stories

### Weekly Outlook

3-4 sentences: What to watch next week. Reference unresolved threats, actors likely to continue, areas needing monitoring.

CRITICAL RULES:
- Use REAL CVE IDs, product names, versions, actor names from the briefing data
- Do NOT fabricate — only reference what appears in the story data
- This is a TACTICAL weekly report — focus on trends and posture shifts, not just listing stories
- The trends and risk assessment sections are the most important — they show PATTERNS not just events
- Return ONLY the markdown, no preamble or closing remarks`;
}

function buildMonthlyPrompt(groups: GroupInput[], stats: PeriodStats): string {
  const allSignals = [...new Set(groups.flatMap((g) => g.signals))].join(", ");
  const signalBreakdown = Object.entries(stats.signalDistribution)
    .slice(0, 10)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");

  return `You are a senior cybersecurity intelligence analyst producing a MONTHLY STRATEGIC INTELLIGENCE REPORT for CISO, CIO, and board-level stakeholders.

Audience: CISO, CIO, Board of Directors, Executive Leadership
Focus: Structural risk posture, systemic trends, and strategic investment guidance

You will receive full briefings for all story groups this month. Produce a strategic-level report — NO raw CVE lists, NO technical noise. Only systemic trends and investment guidance.

## INPUT DATA CONTEXT
- ${stats.totalStories} stories this month (${stats.totalArticles} articles)
- Severity: ${stats.criticalStories} critical, ${stats.vulnerableStories} vulnerable, ${stats.fixedStories} fixed, ${stats.infoStories} informational
- Signal distribution: ${signalBreakdown || "None"}
- Top products mentioned: ${stats.topAffectedProducts.map((p) => `${p.name} (${p.count})`).join(", ") || "None"}
- Top sectors affected: ${stats.topAffectedSectors.map((s) => `${s.name} (${s.count})`).join(", ") || "None"}
- Top entities: ${stats.topEntities.map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ") || "None"}
- CVE Summary: ${stats.uniqueCVEs} unique CVEs, ${stats.criticalCVEs} critical (CVSS>=9.0), ${stats.highCVEs} high, ${stats.mediumCVEs} medium, ${stats.lowCVEs} low
- CISA KEV: ${stats.kevCount} CVEs on Known Exploited Vulnerabilities list
- CVSS Scores: Average ${stats.avgCVSS?.toFixed(1) ?? "N/A"}, Peak ${stats.maxCVSS ?? "N/A"}
- Top CVEs by severity: ${stats.topCVEs.slice(0, 8).map((c) => `${c.cveId} (CVSS ${c.cvssScore}${c.inKEV ? ", KEV" : ""})`).join(", ") || "None"}

## OUTPUT STRUCTURE (return markdown)

### Monthly Risk Posture Snapshot

| Metric | Value |
|---|---|
| Total Stories Tracked | ${stats.totalStories} |
| Total Articles Analyzed | ${stats.totalArticles} |
| Critical (Actively Exploited) | ${stats.criticalStories} |
| Vulnerable (Unpatched Exposure) | ${stats.vulnerableStories} |
| Fixed / Resolved | ${stats.fixedStories} |
| Informational / Research | ${stats.infoStories} |
| Unique CVEs Identified | ${stats.uniqueCVEs} |
| Critical CVEs (CVSS >= 9.0) | ${stats.criticalCVEs} |
| CISA KEV Listed | ${stats.kevCount} |
| Average CVSS Score | ${stats.avgCVSS?.toFixed(1) ?? "N/A"} |

### Executive Summary

A 4-6 sentence strategic overview for executives. Cover:
- The overall threat landscape trajectory this month (escalating, stable, or improving)
- The most significant risks that emerged
- Key areas where organizational exposure increased or decreased
- One sentence on recommended strategic focus

### Structural Risk Observations

Identify 3-5 systemic risk patterns observed across the month's data. For each:

**[Observation Title]** (e.g., "Perimeter Infrastructure Remains Highest Risk Surface")
- What percentage of critical exposure ties to this area
- How exploitation speed or frequency is changing
- Which specific threats drive this observation (reference real stories)
- Business impact if unaddressed

These should be STRUCTURAL observations, not event summaries. Think about what the data reveals about the organization's risk posture.

### Exposure by Technology Layer

Based on the month's data, assess each layer:

| Layer | Exposure Level | Trend | Key Driver |
|---|---|---|---|
| Edge / Perimeter Devices | High / Moderate / Low | ↑ / ↓ / Stable | Brief reason |
| Cloud Workloads | High / Moderate / Low | ↑ / ↓ / Stable | Brief reason |
| Identity & Access Systems | High / Moderate / Low | ↑ / ↓ / Stable | Brief reason |
| Internal Applications | High / Moderate / Low | ↑ / ↓ / Stable | Brief reason |
| Supply Chain / Third-Party | High / Moderate / Low | ↑ / ↓ / Stable | Brief reason |

Only include layers relevant to the data. Assess based on volume of stories, severity of incidents, and exploitation patterns.

### Threat Activity Summary

**Most Active Threat Categories This Month**
Rank the signal categories by activity: ${allSignals || "N/A"}
- Which increased vs last period
- Which threat types dominated

**Notable Threat Actors & Campaigns**
Summarize any recurring threat actors, nation-state activity, or organized campaigns observed across stories.

**Most Targeted Products & Sectors**
Which products and sectors appeared most frequently in vulnerability and incident reports.

### Month-over-Month Trend Analysis

Identify 3-4 key trends with supporting evidence from the stories:
- Are attacks becoming more sophisticated, faster, or more targeted?
- Which vulnerability classes are most prevalent?
- Are defenses improving (more fixes) or deteriorating (more critical exposures)?
- Emerging threat vectors or techniques

### Strategic Recommendations

Long-term investment and capability recommendations — NOT tactical patches:

1. **[Priority Area]** — What to invest in and why (e.g., "Invest in automated edge-device patch orchestration — 60% of critical exposure tied to perimeter devices")
2. **[Priority Area]** — Strategic shift recommendation (e.g., "Reduce VPN surface exposure via zero-trust architecture")
3. **[Priority Area]** — Capability gap to close (e.g., "Improve SBOM coverage for real-time dependency vulnerability detection")
4. **[Priority Area]** — Process improvement (e.g., "Implement KEV-triggered auto-escalation workflow")

Each recommendation should tie directly to patterns observed in the month's data.

### Outlook

4-5 sentences on what to expect next month. Reference:
- Unresolved structural risks
- Threat actors or campaigns likely to continue
- Technology areas requiring sustained attention
- Regulatory or compliance deadlines approaching

CRITICAL RULES:
- This is a BOARD-LEVEL report — NO raw CVE lists, NO technical implementation details
- Focus on SYSTEMIC TRENDS and INVESTMENT GUIDANCE
- Only reference real data from the provided stories — do NOT fabricate
- Every observation must be supported by evidence from the story data
- The tone should be executive: clear, decisive, forward-looking
- Return ONLY the markdown, no preamble or closing remarks`;
}

/**
 * Generates an AI summary for the period using period-specific prompts.
 */
async function generatePeriodSummary(
  groups: GroupInput[],
  period: string,
  stats: PeriodStats
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY || groups.length === 0) return null;

  const periodLabel =
    period === "1d" ? "today" : period === "7d" ? "this week" : "this month";

  // Select period-specific prompt
  let systemPrompt: string;
  let maxTokens: number;

  switch (period) {
    case "1d":
      systemPrompt = buildDailyPrompt(groups, stats);
      maxTokens = 2500;
      break;
    case "7d":
      systemPrompt = buildWeeklyPrompt(groups, stats);
      maxTokens = 3500;
      break;
    case "30d":
      systemPrompt = buildMonthlyPrompt(groups, stats);
      maxTokens = 4000;
      break;
    default:
      return null;
  }

  const truncated = buildGroupContext(groups);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Full intelligence briefings from ${periodLabel} (${groups.length} stories):\n\n${truncated}`,
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PeriodReport] Summary generation failed for ${period}:`, message);
    return null;
  }
}

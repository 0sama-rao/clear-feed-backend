import type { PrismaClient } from "@prisma/client";
import type { RemediationMetrics } from "./remediationTracker.js";

interface PeriodStatsBase {
  totalStories: number;
  totalArticles: number;
  criticalStories: number;
  vulnerableStories: number;
  fixedStories: number;
  infoStories: number;
  uniqueCVEs: number;
  criticalCVEs: number;
  highCVEs: number;
  mediumCVEs: number;
  lowCVEs: number;
  kevCount: number;
  avgCVSS: number | null;
  maxCVSS: number | null;
}

export interface SnapshotMetrics extends PeriodStatsBase {
  exposure: RemediationMetrics;
  exposureByCategory: Record<string, number>;
  topVulnerableProducts: Array<{
    vendor: string;
    product: string;
    count: number;
  }>;
}

export interface TrendDelta {
  current: number;
  previous: number;
  delta: number;
}

export interface TrendDeltaNullable {
  current: number | null;
  previous: number | null;
  delta: number;
}

export interface TrendDeltas {
  totalStories: TrendDelta;
  criticalStories: TrendDelta;
  uniqueCVEs: TrendDelta;
  kevCount: TrendDelta;
  avgCVSS: TrendDeltaNullable;
  vulnerableExposures: TrendDelta;
  patchRate: TrendDelta;
  slaCompliance: TrendDelta;
  mttr: TrendDeltaNullable;
}

/**
 * Creates a periodic metrics snapshot for trend comparison.
 * Called after period report generation.
 */
export async function createPeriodSnapshot(
  prisma: PrismaClient,
  userId: string,
  period: string,
  stats: PeriodStatsBase,
  remediationMetrics: RemediationMetrics
): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Compute exposure by tech category
  const exposures = await prisma.userCVEExposure.findMany({
    where: { userId, exposureState: "VULNERABLE" },
    include: {
      techStackItem: { select: { category: true, vendor: true, product: true } },
    },
  });

  const byCategory: Record<string, number> = {};
  const productCounts = new Map<
    string,
    { vendor: string; product: string; count: number }
  >();

  for (const exp of exposures) {
    if (exp.techStackItem) {
      const cat = exp.techStackItem.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      const key = `${exp.techStackItem.vendor}:${exp.techStackItem.product}`;
      const existing = productCounts.get(key);
      if (existing) existing.count++;
      else
        productCounts.set(key, {
          vendor: exp.techStackItem.vendor,
          product: exp.techStackItem.product,
          count: 1,
        });
    }
  }

  const metrics: SnapshotMetrics = {
    totalStories: stats.totalStories,
    totalArticles: stats.totalArticles,
    criticalStories: stats.criticalStories,
    vulnerableStories: stats.vulnerableStories,
    fixedStories: stats.fixedStories,
    infoStories: stats.infoStories,
    uniqueCVEs: stats.uniqueCVEs,
    criticalCVEs: stats.criticalCVEs,
    highCVEs: stats.highCVEs,
    mediumCVEs: stats.mediumCVEs,
    lowCVEs: stats.lowCVEs,
    kevCount: stats.kevCount,
    avgCVSS: stats.avgCVSS,
    maxCVSS: stats.maxCVSS,
    exposure: remediationMetrics,
    exposureByCategory: byCategory,
    topVulnerableProducts: [...productCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };

  await prisma.periodSnapshot.upsert({
    where: {
      userId_period_snapDate: { userId, period, snapDate: today },
    },
    update: { metrics: metrics as any },
    create: {
      userId,
      period,
      snapDate: today,
      metrics: metrics as any,
    },
  });
}

/**
 * Computes deltas between current metrics and the previous period's snapshot.
 * Returns null if no previous snapshot exists.
 */
export async function computeTrendDeltas(
  prisma: PrismaClient,
  userId: string,
  period: string,
  currentMetrics: SnapshotMetrics
): Promise<TrendDeltas | null> {
  const periodDays = period === "7d" ? 7 : period === "30d" ? 30 : 1;
  const previousDate = new Date();
  previousDate.setDate(previousDate.getDate() - periodDays);
  previousDate.setUTCHours(0, 0, 0, 0);

  const previousSnapshot = await prisma.periodSnapshot.findFirst({
    where: {
      userId,
      period,
      snapDate: { lte: previousDate },
    },
    orderBy: { snapDate: "desc" },
  });

  if (!previousSnapshot) return null;

  const prev = previousSnapshot.metrics as any as SnapshotMetrics;
  if (!prev.exposure) return null;

  return {
    totalStories: {
      current: currentMetrics.totalStories,
      previous: prev.totalStories,
      delta: currentMetrics.totalStories - prev.totalStories,
    },
    criticalStories: {
      current: currentMetrics.criticalStories,
      previous: prev.criticalStories,
      delta: currentMetrics.criticalStories - prev.criticalStories,
    },
    uniqueCVEs: {
      current: currentMetrics.uniqueCVEs,
      previous: prev.uniqueCVEs,
      delta: currentMetrics.uniqueCVEs - prev.uniqueCVEs,
    },
    kevCount: {
      current: currentMetrics.kevCount,
      previous: prev.kevCount,
      delta: currentMetrics.kevCount - prev.kevCount,
    },
    avgCVSS: {
      current: currentMetrics.avgCVSS,
      previous: prev.avgCVSS,
      delta: (currentMetrics.avgCVSS ?? 0) - (prev.avgCVSS ?? 0),
    },
    vulnerableExposures: {
      current: currentMetrics.exposure.totalVulnerable,
      previous: prev.exposure.totalVulnerable ?? 0,
      delta:
        currentMetrics.exposure.totalVulnerable -
        (prev.exposure.totalVulnerable ?? 0),
    },
    patchRate: {
      current: currentMetrics.exposure.patchRate,
      previous: prev.exposure.patchRate ?? 0,
      delta:
        currentMetrics.exposure.patchRate - (prev.exposure.patchRate ?? 0),
    },
    slaCompliance: {
      current: currentMetrics.exposure.slaCompliance,
      previous: prev.exposure.slaCompliance ?? 0,
      delta:
        currentMetrics.exposure.slaCompliance -
        (prev.exposure.slaCompliance ?? 0),
    },
    mttr: {
      current: currentMetrics.exposure.avgMttrDays,
      previous: prev.exposure.avgMttrDays ?? null,
      delta:
        (currentMetrics.exposure.avgMttrDays ?? 0) -
        (prev.exposure.avgMttrDays ?? 0),
    },
  };
}

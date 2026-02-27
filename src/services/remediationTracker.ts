import type { PrismaClient } from "@prisma/client";

export interface RemediationMetrics {
  totalVulnerable: number;
  totalFixed: number;
  totalNotApplicable: number;
  totalIndirect: number;
  totalOverdue: number;
  patchRate: number;
  slaCompliance: number;
  avgMttrDays: number | null;
  medianMttrDays: number | null;
  kevExposureCount: number;
  overdueKevCount: number;
  criticalExposed: number;
  avgCvssExposed: number | null;
}

/**
 * Computes remediation metrics from UserCVEExposure records.
 * Pure database computation — no AI involved.
 */
export async function computeRemediationMetrics(
  prisma: PrismaClient,
  userId: string
): Promise<RemediationMetrics> {
  const exposures = await prisma.userCVEExposure.findMany({
    where: { userId },
    include: {
      articleCve: {
        select: {
          cvssScore: true,
          severity: true,
          inKEV: true,
          kevDueDate: true,
        },
      },
    },
  });

  const now = new Date();

  const vulnerable = exposures.filter(
    (e) => e.exposureState === "VULNERABLE"
  );
  const fixed = exposures.filter((e) => e.exposureState === "FIXED");
  const notApplicable = exposures.filter(
    (e) => e.exposureState === "NOT_APPLICABLE"
  );
  const indirect = exposures.filter((e) => e.exposureState === "INDIRECT");

  // MTTR: (patchedAt - firstDetectedAt) for FIXED exposures
  const mttrValues = fixed
    .filter((e) => e.patchedAt && e.firstDetectedAt)
    .map(
      (e) =>
        (e.patchedAt!.getTime() - e.firstDetectedAt.getTime()) /
        (1000 * 60 * 60 * 24)
    );

  const avgMttr =
    mttrValues.length > 0
      ? mttrValues.reduce((a, b) => a + b, 0) / mttrValues.length
      : null;

  const sortedMttr = [...mttrValues].sort((a, b) => a - b);
  const medianMttr =
    sortedMttr.length > 0
      ? sortedMttr[Math.floor(sortedMttr.length / 2)]
      : null;

  // SLA compliance: % of fixed CVEs patched before deadline
  const fixedWithDeadline = fixed.filter(
    (e) => e.remediationDeadline && e.patchedAt
  );
  const patchedOnTime = fixedWithDeadline.filter(
    (e) => e.patchedAt! <= e.remediationDeadline!
  );
  const slaCompliance =
    fixedWithDeadline.length > 0
      ? (patchedOnTime.length / fixedWithDeadline.length) * 100
      : 100;

  // Patch rate: % of actionable CVEs (VULNERABLE + FIXED) that are FIXED
  const actionable = vulnerable.length + fixed.length;
  const patchRate = actionable > 0 ? (fixed.length / actionable) * 100 : 0;

  // KEV-specific
  const kevExposed = vulnerable.filter((e) => e.articleCve?.inKEV);
  const overdueKev = vulnerable.filter(
    (e) =>
      e.articleCve?.inKEV &&
      e.remediationDeadline &&
      e.remediationDeadline < now
  );

  // Overdue: vulnerable CVEs past deadline
  const overdue = vulnerable.filter(
    (e) => e.remediationDeadline && e.remediationDeadline < now
  );

  // Critical exposed: CVSS >= 9.0 and VULNERABLE
  const criticalExposed = vulnerable.filter(
    (e) => e.articleCve?.cvssScore != null && e.articleCve.cvssScore >= 9.0
  );

  // Average CVSS of exposed (VULNERABLE) CVEs
  const exposedScores = vulnerable
    .filter((e) => e.articleCve?.cvssScore != null)
    .map((e) => e.articleCve!.cvssScore!);
  const avgCvssExposed =
    exposedScores.length > 0
      ? exposedScores.reduce((a, b) => a + b, 0) / exposedScores.length
      : null;

  return {
    totalVulnerable: vulnerable.length,
    totalFixed: fixed.length,
    totalNotApplicable: notApplicable.length,
    totalIndirect: indirect.length,
    totalOverdue: overdue.length,
    patchRate: Math.round(patchRate * 10) / 10,
    slaCompliance: Math.round(slaCompliance * 10) / 10,
    avgMttrDays: avgMttr !== null ? Math.round(avgMttr * 10) / 10 : null,
    medianMttrDays:
      medianMttr !== null ? Math.round(medianMttr * 10) / 10 : null,
    kevExposureCount: kevExposed.length,
    overdueKevCount: overdueKev.length,
    criticalExposed: criticalExposed.length,
    avgCvssExposed:
      avgCvssExposed !== null
        ? Math.round(avgCvssExposed * 10) / 10
        : null,
  };
}

import type { PrismaClient } from "@prisma/client";

/**
 * CPE 2.3 parsing, matching, and exposure classification.
 *
 * CPE format: cpe:2.3:PART:VENDOR:PRODUCT:VERSION:UPDATE:EDITION:LANG:SW_ED:TARGET_SW:TARGET_HW:OTHER
 * Example: cpe:2.3:a:apache:http_server:2.4.51:*:*:*:*:*:*:*
 */

interface ParsedCPE {
  part: string;
  vendor: string;
  product: string;
  version: string;
}

/**
 * Generates a CPE match pattern from vendor + product.
 * Used for prefix matching against full CPE strings from NVD.
 */
export function generateCpePattern(vendor: string, product: string): string {
  const v = vendor.toLowerCase().replace(/\s+/g, "_");
  const p = product.toLowerCase().replace(/\s+/g, "_");
  return `cpe:2.3:*:${v}:${p}`;
}

/**
 * Parses a CPE 2.3 string into its key components.
 */
function parseCPE(cpe: string): ParsedCPE | null {
  const parts = cpe.split(":");
  if (parts.length < 6 || parts[0] !== "cpe" || parts[1] !== "2.3") return null;
  return {
    part: parts[2],
    vendor: parts[3],
    product: parts[4],
    version: parts[5] || "*",
  };
}

type MatchLevel = "exact" | "product" | "vendor";

/**
 * Checks if a user's tech stack item matches a CVE's CPE string.
 * Returns match level or null if no match.
 */
function matchCPE(
  techItem: { vendor: string; product: string; version: string | null },
  cveCpe: string
): MatchLevel | null {
  const parsed = parseCPE(cveCpe);
  if (!parsed) return null;

  const vendorMatch =
    parsed.vendor === techItem.vendor.toLowerCase().replace(/\s+/g, "_");
  if (!vendorMatch) return null;

  const productMatch =
    parsed.product === techItem.product.toLowerCase().replace(/\s+/g, "_");
  if (!productMatch) return "vendor";

  // Product matches. Check version.
  if (!techItem.version || parsed.version === "*") return "product";

  // Exact or prefix version match
  if (
    parsed.version === techItem.version ||
    techItem.version.startsWith(parsed.version)
  ) {
    return "exact";
  }

  return "product";
}

function matchRank(result: MatchLevel): number {
  return result === "exact" ? 3 : result === "product" ? 2 : 1;
}

/**
 * Classifies exposure state based on CPE match level.
 */
function classifyExposure(matchResult: MatchLevel | null): string {
  if (matchResult === null) return "NOT_APPLICABLE";
  if (matchResult === "vendor") return "INDIRECT";
  return "VULNERABLE";
}

export interface ExposureCandidate {
  cveId: string;
  articleCveId: string;
  techStackItemId: string | null;
  exposureState: string;
  matchedCpe: string | null;
  remediationDeadline: Date | null;
}

/**
 * Matches a set of ArticleCVEs against a user's tech stack.
 * Returns exposure classification for each CVE.
 */
export function matchCVEsAgainstStack(
  techStack: Array<{
    id: string;
    vendor: string;
    product: string;
    version: string | null;
  }>,
  articleCves: Array<{
    id: string;
    cveId: string;
    cpeMatches: unknown;
    kevDueDate: Date | null;
  }>
): ExposureCandidate[] {
  const results: ExposureCandidate[] = [];
  const seen = new Set<string>();

  if (techStack.length === 0) return results;

  for (const acve of articleCves) {
    if (seen.has(acve.cveId)) continue;
    seen.add(acve.cveId);

    const cpeList = Array.isArray(acve.cpeMatches)
      ? (acve.cpeMatches as string[])
      : [];

    let bestMatch: {
      result: MatchLevel;
      techItemId: string;
      cpe: string;
    } | null = null;

    for (const cpe of cpeList) {
      for (const item of techStack) {
        const result = matchCPE(item, cpe);
        if (result === null) continue;

        if (!bestMatch || matchRank(result) > matchRank(bestMatch.result)) {
          bestMatch = { result, techItemId: item.id, cpe };
        }
      }
    }

    if (bestMatch) {
      results.push({
        cveId: acve.cveId,
        articleCveId: acve.id,
        techStackItemId: bestMatch.techItemId,
        exposureState: classifyExposure(bestMatch.result),
        matchedCpe: bestMatch.cpe,
        remediationDeadline: acve.kevDueDate || null,
      });
    } else if (cpeList.length > 0) {
      results.push({
        cveId: acve.cveId,
        articleCveId: acve.id,
        techStackItemId: null,
        exposureState: "NOT_APPLICABLE",
        matchedCpe: null,
        remediationDeadline: null,
      });
    }
  }

  return results;
}

/**
 * Retroactively matches a newly added tech stack item against all existing
 * ArticleCVEs for the user's articles.
 */
export async function retroactiveMatchForStackItem(
  prisma: PrismaClient,
  userId: string,
  stackItem: {
    id: string;
    vendor: string;
    product: string;
    version: string | null;
  }
): Promise<number> {
  // Get all ArticleCVEs from this user's matched articles
  const userArticles = await prisma.userArticle.findMany({
    where: { userId, matched: true },
    select: { articleId: true },
  });

  if (userArticles.length === 0) return 0;

  const articleCves = await prisma.articleCVE.findMany({
    where: { articleId: { in: userArticles.map((ua) => ua.articleId) } },
    select: { id: true, cveId: true, cpeMatches: true, kevDueDate: true },
  });

  if (articleCves.length === 0) return 0;

  // Get existing exposures to avoid overwriting manual classifications
  const existingExposures = await prisma.userCVEExposure.findMany({
    where: { userId },
    select: { cveId: true, autoClassified: true },
  });
  const existingMap = new Map(
    existingExposures.map((e) => [e.cveId, e.autoClassified])
  );

  let created = 0;
  const seenCves = new Set<string>();

  for (const acve of articleCves) {
    if (seenCves.has(acve.cveId)) continue;
    seenCves.add(acve.cveId);

    // Skip if manually classified
    if (existingMap.has(acve.cveId) && !existingMap.get(acve.cveId)) continue;

    const cpeList = Array.isArray(acve.cpeMatches)
      ? (acve.cpeMatches as string[])
      : [];

    for (const cpe of cpeList) {
      const result = matchCPE(stackItem, cpe);
      if (result && (result === "exact" || result === "product")) {
        try {
          await prisma.userCVEExposure.upsert({
            where: { userId_cveId: { userId, cveId: acve.cveId } },
            update: {
              techStackItemId: stackItem.id,
              exposureState: classifyExposure(result) as any,
              matchedCpe: cpe,
              autoClassified: true,
            },
            create: {
              userId,
              cveId: acve.cveId,
              articleCveId: acve.id,
              techStackItemId: stackItem.id,
              exposureState: classifyExposure(result) as any,
              matchedCpe: cpe,
              remediationDeadline: acve.kevDueDate || null,
              autoClassified: true,
            },
          });
          created++;
        } catch {
          // Skip duplicates
        }
        break;
      }
    }
  }

  return created;
}

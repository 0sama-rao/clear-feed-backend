import type { PrismaClient } from "@prisma/client";

const CVE_REGEX = /CVE-\d{4}-\d{4,7}/gi;

// ── NVD API rate limiter ──
const NVD_API_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

class NVDRateLimiter {
  private timestamps: number[] = [];
  private maxPerWindow: number;
  private windowMs = 30_000;

  constructor(hasApiKey: boolean) {
    this.maxPerWindow = hasApiKey ? 50 : 5;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxPerWindow) {
      const oldest = this.timestamps[0];
      const waitMs = oldest + this.windowMs - now + 100;
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.timestamps = this.timestamps.filter((t) => Date.now() - t < this.windowMs);
    }

    this.timestamps.push(Date.now());
    return fn();
  }
}

// ── CISA KEV cache ──
interface KEVEntry {
  cveID: string;
  dateAdded: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
  vendorProject: string;
  product: string;
}

let kevCache: Map<string, KEVEntry> | null = null;
let kevCacheTimestamp = 0;
const KEV_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getKEVData(): Promise<Map<string, KEVEntry>> {
  if (kevCache && Date.now() - kevCacheTimestamp < KEV_CACHE_TTL) {
    return kevCache;
  }

  try {
    const response = await fetch(
      "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
      { signal: AbortSignal.timeout(30000) }
    );
    const data = (await response.json()) as { vulnerabilities: KEVEntry[] };

    kevCache = new Map();
    for (const vuln of data.vulnerabilities) {
      kevCache.set(vuln.cveID, vuln);
    }
    kevCacheTimestamp = Date.now();

    console.log(`[CVEExtractor] KEV cache refreshed: ${kevCache.size} entries`);
    return kevCache;
  } catch (err) {
    console.error(`[CVEExtractor] KEV fetch failed:`, err instanceof Error ? err.message : err);
    return kevCache ?? new Map();
  }
}

// ── NVD API client ──
interface NVDVulnerability {
  cvssScore: number | null;
  severity: string | null;
  description: string | null;
  cpeMatches: string[];
  publishedDate: Date | null;
}

async function fetchNVDData(cveId: string): Promise<NVDVulnerability | null> {
  const url = new URL(NVD_API_BASE);
  url.searchParams.set("cveId", cveId);

  const headers: Record<string, string> = {};
  if (process.env.NVD_API_KEY) {
    headers["apiKey"] = process.env.NVD_API_KEY;
  }

  const response = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    console.error(`[CVEExtractor] NVD API ${response.status} for ${cveId}`);
    return null;
  }

  const data = (await response.json()) as {
    vulnerabilities?: Array<{
      cve: {
        id: string;
        descriptions?: Array<{ lang: string; value: string }>;
        metrics?: {
          cvssMetricV31?: Array<{ cvssData: { baseScore: number; baseSeverity: string } }>;
          cvssMetricV30?: Array<{ cvssData: { baseScore: number; baseSeverity: string } }>;
          cvssMetricV2?: Array<{ cvssData: { baseScore: number } }>;
        };
        configurations?: Array<{
          nodes: Array<{ cpeMatch: Array<{ criteria: string }> }>;
        }>;
        published?: string;
      };
    }>;
  };

  const vuln = data.vulnerabilities?.[0]?.cve;
  if (!vuln) return null;

  // CVSS: try v3.1 → v3.0 → v2
  const v31 = vuln.metrics?.cvssMetricV31?.[0]?.cvssData;
  const v30 = vuln.metrics?.cvssMetricV30?.[0]?.cvssData;
  const v2 = vuln.metrics?.cvssMetricV2?.[0]?.cvssData;
  const cvssScore = v31?.baseScore ?? v30?.baseScore ?? v2?.baseScore ?? null;
  const severity = v31?.baseSeverity ?? v30?.baseSeverity ?? null;

  // Description (English)
  const description =
    vuln.descriptions?.find((d) => d.lang === "en")?.value ?? null;

  // CPE matches
  const cpeMatches: string[] = [];
  for (const config of vuln.configurations ?? []) {
    for (const node of config.nodes) {
      for (const match of node.cpeMatch) {
        cpeMatches.push(match.criteria);
      }
    }
  }

  return {
    cvssScore,
    severity,
    description: description?.slice(0, 2000) ?? null,
    cpeMatches,
    publishedDate: vuln.published ? new Date(vuln.published) : null,
  };
}

// ── Public API ──

/** Extract CVE IDs from text using regex */
export function extractCVEIds(text: string): string[] {
  const matches = text.match(CVE_REGEX) || [];
  return [...new Set(matches.map((m) => m.toUpperCase()))];
}

export interface CVEData {
  cveId: string;
  cvssScore: number | null;
  severity: string | null;
  description: string | null;
  cpeMatches: string[];
  publishedDate: Date | null;
  inKEV: boolean;
  kevDateAdded: Date | null;
  kevDueDate: Date | null;
  kevRansomwareUse: string | null;
}

/**
 * Extracts CVE IDs from articles, enriches them via NVD API, and checks CISA KEV.
 * Deduplicates: same CVE across articles → 1 NVD call. Previously enriched CVEs → 0 calls.
 */
export async function enrichArticleCVEs(
  prisma: PrismaClient,
  articles: Array<{ id: string; title: string; cleanText: string | null; content: string }>
): Promise<Map<string, CVEData[]>> {
  const resultMap = new Map<string, CVEData[]>();

  // 1. Extract CVE IDs from all articles
  const allCVEIds = new Set<string>();
  const articleCVEMap = new Map<string, string[]>();

  for (const article of articles) {
    const text = [article.title, article.cleanText || article.content].join(" ");
    const cveIds = extractCVEIds(text);
    if (cveIds.length > 0) {
      articleCVEMap.set(article.id, cveIds);
      cveIds.forEach((id) => allCVEIds.add(id));
    }
  }

  if (allCVEIds.size === 0) return resultMap;

  console.log(
    `[CVEExtractor] Found ${allCVEIds.size} unique CVE IDs across ${articleCVEMap.size} articles`
  );

  // 2. Check which CVEs we already have enrichment data for
  const existingCVEs = await prisma.articleCVE.findMany({
    where: { cveId: { in: [...allCVEIds] } },
    distinct: ["cveId"],
    select: {
      cveId: true,
      cvssScore: true,
      severity: true,
      description: true,
      cpeMatches: true,
      publishedDate: true,
      inKEV: true,
      kevDateAdded: true,
      kevDueDate: true,
      kevRansomwareUse: true,
    },
  });
  const existingCVEMap = new Map(existingCVEs.map((c) => [c.cveId, c]));

  // 3. Fetch NVD data for NEW CVEs only
  const newCVEIds = [...allCVEIds].filter((id) => !existingCVEMap.has(id));
  const nvdData = new Map<string, NVDVulnerability>();

  if (newCVEIds.length > 0) {
    console.log(
      `[CVEExtractor] Fetching NVD data for ${newCVEIds.length} new CVEs (${existingCVEs.length} cached)...`
    );
    const rateLimiter = new NVDRateLimiter(!!process.env.NVD_API_KEY);

    for (const cveId of newCVEIds) {
      try {
        const data = await rateLimiter.execute(() => fetchNVDData(cveId));
        if (data) nvdData.set(cveId, data);
      } catch (err) {
        console.error(
          `[CVEExtractor] NVD fetch failed for ${cveId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // 4. Check KEV status for all CVEs
  const kevData = await getKEVData();

  // 5. Build result map
  for (const [articleId, cveIds] of articleCVEMap) {
    const articleCVEs: CVEData[] = [];

    for (const cveId of cveIds) {
      const existing = existingCVEMap.get(cveId);
      const nvd = nvdData.get(cveId);
      const kev = kevData.get(cveId);

      articleCVEs.push({
        cveId,
        cvssScore: existing?.cvssScore ?? nvd?.cvssScore ?? null,
        severity: existing?.severity ?? nvd?.severity ?? null,
        description: existing?.description ?? nvd?.description ?? null,
        cpeMatches: (existing?.cpeMatches as string[]) ?? nvd?.cpeMatches ?? [],
        publishedDate: existing?.publishedDate ?? nvd?.publishedDate ?? null,
        inKEV: existing?.inKEV ?? !!kev,
        kevDateAdded: existing?.kevDateAdded ?? (kev ? new Date(kev.dateAdded) : null),
        kevDueDate: existing?.kevDueDate ?? (kev ? new Date(kev.dueDate) : null),
        kevRansomwareUse:
          existing?.kevRansomwareUse ?? kev?.knownRansomwareCampaignUse ?? null,
      });
    }

    resultMap.set(articleId, articleCVEs);
  }

  console.log(
    `[CVEExtractor] Enrichment complete: ${allCVEIds.size} CVEs, ${nvdData.size} NVD lookups, ${[...allCVEIds].filter((id) => kevData.has(id)).length} KEV matches`
  );

  return resultMap;
}

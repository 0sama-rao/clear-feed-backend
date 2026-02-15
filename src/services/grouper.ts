export interface ArticleForGrouping {
  id: string;
  title: string;
  publishedAt: Date | null;
  entities: Array<{ type: string; name: string }>;
  signals: Array<{ slug: string }>;
  matchedKeywords: string[];
}

export interface ArticleGroup {
  title: string;
  articleIds: string[];
  confidence: number;
  dominantSignals: string[];
  dominantEntities: string[];
}

const SIMILARITY_THRESHOLD = 0.3;
const MAX_GROUP_SIZE = 10;

/**
 * IDF (Inverse Document Frequency) weights for signals, entities, and keywords.
 * Common terms get low weight; rare terms get high weight.
 */
interface IDFWeights {
  N: number;
  signals: Map<string, number>;
  entities: Map<string, number>;
  keywords: Map<string, number>;
}

/**
 * Clusters articles into groups based on shared entities, signals,
 * keyword overlap, and temporal proximity. Uses IDF weighting so
 * common signals (e.g. "vulnerability") don't dominate clustering.
 */
export function groupArticles(articles: ArticleForGrouping[]): ArticleGroup[] {
  if (articles.length === 0) return [];
  if (articles.length === 1) {
    return [makeSingletonGroup(articles[0])];
  }

  // Pre-compute IDF weights across corpus
  const idf = computeIDF(articles);

  // Build similarity matrix
  const similarities: Array<{ i: number; j: number; score: number }> = [];
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const score = computeSimilarity(articles[i], articles[j], idf);
      if (score >= SIMILARITY_THRESHOLD) {
        similarities.push({ i, j, score });
      }
    }
  }

  // Sort by similarity descending for greedy clustering
  similarities.sort((a, b) => b.score - a.score);

  // Greedy clustering with max group size cap
  const articleToGroup = new Map<number, number>();
  const groups: Set<number>[] = [];

  for (const { i, j } of similarities) {
    const groupI = articleToGroup.get(i);
    const groupJ = articleToGroup.get(j);

    if (groupI === undefined && groupJ === undefined) {
      // Both unassigned → create new group
      const gIdx = groups.length;
      groups.push(new Set([i, j]));
      articleToGroup.set(i, gIdx);
      articleToGroup.set(j, gIdx);
    } else if (groupI !== undefined && groupJ === undefined) {
      // j joins i's group — only if under size cap
      if (groups[groupI].size < MAX_GROUP_SIZE) {
        groups[groupI].add(j);
        articleToGroup.set(j, groupI);
      }
    } else if (groupI === undefined && groupJ !== undefined) {
      // i joins j's group — only if under size cap
      if (groups[groupJ].size < MAX_GROUP_SIZE) {
        groups[groupJ].add(i);
        articleToGroup.set(i, groupJ);
      }
    } else if (groupI !== undefined && groupJ !== undefined && groupI !== groupJ) {
      // Merge only if combined size is under cap
      if (groups[groupI].size + groups[groupJ].size <= MAX_GROUP_SIZE) {
        const [larger, smaller] =
          groups[groupI].size >= groups[groupJ].size
            ? [groupI, groupJ]
            : [groupJ, groupI];
        for (const idx of groups[smaller]) {
          groups[larger].add(idx);
          articleToGroup.set(idx, larger);
        }
        groups[smaller] = new Set();
      }
    }
  }

  // Add unassigned articles as singleton groups
  for (let i = 0; i < articles.length; i++) {
    if (!articleToGroup.has(i)) {
      groups.push(new Set([i]));
    }
  }

  // Build output groups (skip empty groups from merging)
  const result: ArticleGroup[] = [];
  for (const group of groups) {
    if (group.size === 0) continue;

    const groupArticles = [...group].map((idx) => articles[idx]);
    const articleIds = groupArticles.map((a) => a.id);

    // Compute average pairwise similarity within the group
    let totalSim = 0;
    let pairs = 0;
    const idxArr = [...group];
    for (let x = 0; x < idxArr.length; x++) {
      for (let y = x + 1; y < idxArr.length; y++) {
        totalSim += computeSimilarity(articles[idxArr[x]], articles[idxArr[y]], idf);
        pairs++;
      }
    }
    const confidence = pairs > 0 ? totalSim / pairs : 0.5;

    // Find dominant entities and signals
    const dominantEntities = getTopItems(
      groupArticles.flatMap((a) => a.entities.map((e) => e.name)),
      3
    );
    const dominantSignals = getTopItems(
      groupArticles.flatMap((a) => a.signals.map((s) => s.slug)),
      3
    );

    const title = generateGroupTitle(dominantEntities, dominantSignals, groupArticles);

    result.push({
      title,
      articleIds,
      confidence: Math.round(confidence * 100) / 100,
      dominantSignals,
      dominantEntities,
    });
  }

  // Sort by number of articles descending
  result.sort((a, b) => b.articleIds.length - a.articleIds.length);

  return result;
}

/**
 * Pre-computes IDF weights for all signals, entities, and keywords
 * across the corpus. IDF = log(N / docFreq) / log(N), normalized to 0-1.
 * Terms appearing in every article get weight ~0; rare terms get weight ~1.
 */
function computeIDF(articles: ArticleForGrouping[]): IDFWeights {
  const N = articles.length;
  const signalDF = new Map<string, number>();
  const entityDF = new Map<string, number>();
  const keywordDF = new Map<string, number>();

  for (const a of articles) {
    const uniqueSignals = new Set(a.signals.map((s) => s.slug));
    for (const s of uniqueSignals) signalDF.set(s, (signalDF.get(s) || 0) + 1);

    const uniqueEntities = new Set(a.entities.map((e) => e.name.toLowerCase()));
    for (const e of uniqueEntities) entityDF.set(e, (entityDF.get(e) || 0) + 1);

    const uniqueKw = new Set(a.matchedKeywords.map((k) => k.toLowerCase()));
    for (const k of uniqueKw) keywordDF.set(k, (keywordDF.get(k) || 0) + 1);
  }

  const toIDF = (dfMap: Map<string, number>) => {
    const idfMap = new Map<string, number>();
    for (const [term, df] of dfMap) {
      // IDF: log(N/df) / log(N) — normalized so max is 1.0
      // A term in every doc → log(1)/log(N) = 0
      // A term in 1 doc → log(N)/log(N) = 1
      idfMap.set(term, Math.log(N / df) / Math.log(N));
    }
    return idfMap;
  };

  return {
    N,
    signals: toIDF(signalDF),
    entities: toIDF(entityDF),
    keywords: toIDF(keywordDF),
  };
}

/**
 * Computes similarity between two articles using IDF-weighted Jaccard
 * for entities, signals, and keywords, plus temporal proximity.
 *
 * Dimensional weights: entities 0.35, signals 0.30, keywords 0.15, temporal 0.20
 * Max score: 1.0
 */
function computeSimilarity(
  a: ArticleForGrouping,
  b: ArticleForGrouping,
  idf: IDFWeights
): number {
  // IDF-weighted Jaccard for entities
  const entitySim = weightedJaccard(
    a.entities.map((e) => e.name.toLowerCase()),
    b.entities.map((e) => e.name.toLowerCase()),
    idf.entities
  );

  // IDF-weighted Jaccard for signals
  const signalSim = weightedJaccard(
    a.signals.map((s) => s.slug),
    b.signals.map((s) => s.slug),
    idf.signals
  );

  // IDF-weighted Jaccard for keywords
  const kwSim = weightedJaccard(
    a.matchedKeywords.map((k) => k.toLowerCase()),
    b.matchedKeywords.map((k) => k.toLowerCase()),
    idf.keywords
  );

  // Temporal proximity: 1.0 if same day, falls off linearly over 3 days
  let temporal = 0;
  if (a.publishedAt && b.publishedAt) {
    const diffHours =
      Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime()) / (60 * 60 * 1000);
    if (diffHours <= 72) {
      temporal = 1.0 - diffHours / 72;
    }
  }

  // Weighted combination
  return entitySim * 0.35 + signalSim * 0.30 + kwSim * 0.15 + temporal * 0.20;
}

/**
 * IDF-weighted Jaccard similarity between two sets.
 * J_w(A,B) = sum(idf(A∩B)) / sum(idf(A∪B))
 * Returns 0 when both sets are empty or union weight is 0.
 */
function weightedJaccard(
  aItems: string[],
  bItems: string[],
  idfWeights: Map<string, number>
): number {
  const setA = new Set(aItems);
  const setB = new Set(bItems);
  const unionSet = new Set([...setA, ...setB]);

  if (unionSet.size === 0) return 0;

  let intersectionWeight = 0;
  let unionWeight = 0;

  for (const item of unionSet) {
    const w = idfWeights.get(item) ?? 1.0;
    unionWeight += w;
    if (setA.has(item) && setB.has(item)) {
      intersectionWeight += w;
    }
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

/**
 * Returns the top N most frequent items from an array.
 */
function getTopItems(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

/**
 * Generates a descriptive group title from dominant entities and signals.
 */
function generateGroupTitle(
  entities: string[],
  signals: string[],
  articles: ArticleForGrouping[]
): string {
  const entity = entities[0];
  const signal = signals[0];

  if (entity && signal) {
    const signalLabel = signal
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return `${entity}: ${signalLabel}`;
  }

  if (entity) return `${entity} Incident`;
  if (signal) {
    const signalLabel = signal
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return `${signalLabel} Activity`;
  }

  return articles[0]?.title || "Uncategorized Group";
}

function makeSingletonGroup(article: ArticleForGrouping): ArticleGroup {
  return {
    title:
      article.entities[0]?.name && article.signals[0]?.slug
        ? generateGroupTitle(
            [article.entities[0].name],
            [article.signals[0].slug],
            [article]
          )
        : article.title,
    articleIds: [article.id],
    confidence: 0.5,
    dominantSignals: article.signals.map((s) => s.slug).slice(0, 3),
    dominantEntities: article.entities.map((e) => e.name).slice(0, 3),
  };
}

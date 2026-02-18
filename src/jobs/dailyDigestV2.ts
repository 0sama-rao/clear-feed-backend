import type { PrismaClient } from "@prisma/client";
import { scrapeUserSources } from "../services/scraper.js";
import { matchArticles, getUserKeywords } from "../services/matcher.js";
import { extractArticleContent } from "../services/extractor.js";
import { extractEntitiesBatch } from "../services/entityExtractor.js";
import { groupArticles, type ArticleForGrouping } from "../services/grouper.js";
import { generateGroupBriefing } from "../services/briefingGenerator.js";
import { generatePeriodReport, generateAllPeriodReports } from "../services/periodReportGenerator.js";
import type { DigestResult } from "./dailyDigest.js";

const CONTENT_BATCH_SIZE = 15; // parallel content extractions (HTTP fetches)
const ENTITY_BATCH_SIZE = 5;   // articles per single OpenAI entity extraction call
const BRIEFING_BATCH_SIZE = 10; // parallel OpenAI briefing calls

/**
 * V2 digest pipeline for onboarded users.
 * Steps: scrape → match → store → extract content+entities per article (parallel) → group → brief (parallel)
 */
export async function runDigestForUserV2(
  prisma: PrismaClient,
  userId: string
): Promise<DigestResult> {
  const startTime = Date.now();
  const result: DigestResult = {
    userId,
    scraped: 0,
    matched: 0,
    summarized: 0,
    errors: [],
  };

  try {
    // Load user's industry signals for entity extraction
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { industryId: true },
    });

    const industrySignals = user?.industryId
      ? await prisma.industrySignal.findMany({
          where: { industryId: user.industryId },
          select: { id: true, slug: true, name: true },
        })
      : [];
    const signalSlugs = industrySignals.map((s) => s.slug);
    const signalMap = new Map(industrySignals.map((s) => [s.slug, s]));

    // ── Step 1: Scrape RSS feeds ──
    console.log(`[DigestV2] User ${userId}: Starting scrape...`);
    const { articles: scrapedArticles, errors: scrapeErrors } =
      await scrapeUserSources(prisma, userId);
    result.scraped = scrapedArticles.length;
    result.errors.push(...scrapeErrors);

    if (scrapedArticles.length === 0) {
      console.log(`[DigestV2] User ${userId}: No new articles found.`);
      await groupAndBriefUngrouped(prisma, userId, signalMap, result);
      return result;
    }

    // ── Step 2: Match against keywords ──
    console.log(`[DigestV2] User ${userId}: Matching ${scrapedArticles.length} articles...`);
    const keywords = await getUserKeywords(prisma, userId);
    const matchResults = matchArticles(scrapedArticles, keywords);
    const matchedResults = matchResults.filter((r) => r.matched);
    result.matched = matchedResults.length;

    // ── Step 3: Store only MATCHED articles (skip unmatched — saves OpenAI calls) ──
    const storedArticles: Array<{
      articleId: string;
      url: string;
      title: string;
    }> = [];

    for (const matchResult of matchedResults) {
      try {
        let article = await prisma.article.findUnique({
          where: { url: matchResult.article.url },
        });

        if (!article) {
          article = await prisma.article.create({
            data: {
              title: matchResult.article.title,
              url: matchResult.article.url,
              content: matchResult.article.content,
              publishedAt: matchResult.article.publishedAt,
              sourceId: matchResult.article.sourceId,
              author: matchResult.article.author || null,
              tags: matchResult.article.tags || [],
              guid: matchResult.article.guid || null,
            },
          });
        }

        // Create UserArticle link
        await prisma.userArticle.upsert({
          where: {
            userId_articleId: { userId, articleId: article.id },
          },
          update: {
            matched: true,
            matchedKeywords: matchResult.matchedKeywords,
          },
          create: {
            userId,
            articleId: article.id,
            matched: true,
            matchedKeywords: matchResult.matchedKeywords,
          },
        });

        storedArticles.push({
          articleId: article.id,
          url: article.url,
          title: article.title,
        });
      } catch (err) {
        if (isDuplicateError(err)) continue;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`[Article: ${matchResult.article.title}] ${message}`);
      }
    }

    // ── Step 4a: Extract content in parallel (HTTP fetches, no AI) ──
    const needsContent = await prisma.article.findMany({
      where: {
        id: { in: storedArticles.map((a) => a.articleId) },
        cleanText: null,
      },
      select: { id: true, url: true, title: true },
    });

    if (needsContent.length > 0) {
      console.log(`[DigestV2] User ${userId}: Extracting content for ${needsContent.length} articles (batches of ${CONTENT_BATCH_SIZE})...`);
      for (let i = 0; i < needsContent.length; i += CONTENT_BATCH_SIZE) {
        const batch = needsContent.slice(i, i + CONTENT_BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (article) => {
            try {
              const extracted = await extractArticleContent(article.url);
              if (extracted) {
                await prisma.article.update({
                  where: { id: article.id },
                  data: {
                    cleanText: extracted.cleanText,
                    rawHtml: extracted.rawHtml,
                    externalLinks: extracted.externalLinks,
                    author: extracted.author || undefined,
                  },
                });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[DigestV2] Content extraction failed for "${article.title}": ${msg}`);
            }
          })
        );
      }
    }

    // ── Step 4b: Batch entity extraction (multiple articles per OpenAI call) ──
    const needsEntities = await prisma.article.findMany({
      where: {
        id: { in: storedArticles.map((a) => a.articleId) },
        entitiesExtracted: false,
      },
      select: { id: true, title: true, cleanText: true, content: true },
    });

    if (needsEntities.length > 0 && signalSlugs.length > 0) {
      console.log(`[DigestV2] User ${userId}: Extracting entities for ${needsEntities.length} articles (${ENTITY_BATCH_SIZE} per AI call)...`);

      for (let i = 0; i < needsEntities.length; i += ENTITY_BATCH_SIZE) {
        const batch = needsEntities.slice(i, i + ENTITY_BATCH_SIZE);
        const batchInput = batch.map((a) => ({
          id: a.id,
          title: a.title,
          text: a.cleanText || a.content,
        }));

        const entitiesMap = await extractEntitiesBatch(batchInput, signalSlugs);

        // Store results for each article in the batch
        for (const article of batch) {
          const entities = entitiesMap.get(article.id);
          if (!entities) continue;

          try {
            const entityRecords = [
              ...entities.companies.map((e) => ({ ...e, type: "COMPANY" as const })),
              ...entities.people.map((e) => ({ ...e, type: "PERSON" as const })),
              ...entities.products.map((e) => ({ ...e, type: "PRODUCT" as const })),
              ...entities.geographies.map((e) => ({ ...e, type: "GEOGRAPHY" as const })),
              ...entities.sectors.map((e) => ({ ...e, type: "SECTOR" as const })),
            ];

            if (entityRecords.length > 0) {
              await prisma.articleEntity.createMany({
                data: entityRecords.map((e) => ({
                  articleId: article.id,
                  type: e.type,
                  name: e.name,
                  confidence: e.confidence,
                })),
                skipDuplicates: true,
              });
            }

            for (const signal of entities.signals) {
              const signalRecord = signalMap.get(signal.slug);
              if (signalRecord) {
                await prisma.articleSignal.upsert({
                  where: {
                    articleId_industrySignalId: {
                      articleId: article.id,
                      industrySignalId: signalRecord.id,
                    },
                  },
                  update: { confidence: signal.confidence },
                  create: {
                    articleId: article.id,
                    industrySignalId: signalRecord.id,
                    confidence: signal.confidence,
                  },
                });
              }
            }

            await prisma.article.update({
              where: { id: article.id },
              data: { entitiesExtracted: true },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[DigestV2] Entity storage failed for "${article.title}": ${msg}`);
          }
        }
      }
    }

    // ── Step 6: Group and brief ──
    await groupAndBriefUngrouped(prisma, userId, signalMap, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`[Fatal] ${message}`);
    console.error(`[DigestV2] Fatal error for user ${userId}:`, message);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[DigestV2] User ${userId}: Done in ${duration}s — ` +
      `${result.scraped} scraped, ${result.matched} matched, ` +
      `${result.summarized} briefed, ${result.errors.length} errors`
  );

  return result;
}

/**
 * Groups ungrouped matched articles and generates briefings for new groups.
 * Briefings are generated in parallel batches for speed.
 */
async function groupAndBriefUngrouped(
  prisma: PrismaClient,
  userId: string,
  signalMap: Map<string, { id: string; slug: string; name: string }>,
  result: DigestResult
): Promise<void> {
  const ungrouped = await prisma.userArticle.findMany({
    where: { userId, matched: true, newsGroupId: null },
    include: {
      article: {
        include: {
          entities: true,
          articleSignals: { include: { industrySignal: true } },
        },
      },
    },
  });

  if (ungrouped.length === 0) {
    console.log(`[DigestV2] User ${userId}: No ungrouped articles to cluster.`);
    // Still generate period reports — they aggregate ALL existing groups, not just new ones
    await generateAllPeriodReports(prisma, userId);
    return;
  }

  console.log(`[DigestV2] User ${userId}: Grouping ${ungrouped.length} articles...`);

  const articlesForGrouping: (ArticleForGrouping & { userArticleId: string })[] =
    ungrouped.map((ua) => ({
      id: ua.article.id,
      userArticleId: ua.id,
      title: ua.article.title,
      publishedAt: ua.article.publishedAt,
      entities: ua.article.entities.map((e) => ({ type: e.type, name: e.name })),
      signals: ua.article.articleSignals.map((as) => ({ slug: as.industrySignal.slug })),
      matchedKeywords: (ua.matchedKeywords as string[]) || [],
    }));

  const groups = groupArticles(articlesForGrouping);
  console.log(`[DigestV2] User ${userId}: Created ${groups.length} groups.`);

  // Create all group records first (fast, sequential DB ops)
  const groupRecords: Array<{
    groupId: string;
    articleIds: string[];
    title: string;
  }> = [];

  for (const group of groups) {
    const newsGroup = await prisma.newsGroup.create({
      data: { userId, title: group.title, confidence: group.confidence },
    });

    // Link articles to the group
    const groupUAIds = ungrouped
      .filter((ua) => group.articleIds.includes(ua.article.id))
      .map((ua) => ua.id);

    if (groupUAIds.length > 0) {
      await prisma.userArticle.updateMany({
        where: { id: { in: groupUAIds } },
        data: { newsGroupId: newsGroup.id },
      });
    }

    groupRecords.push({
      groupId: newsGroup.id,
      articleIds: group.articleIds,
      title: group.title,
    });
  }

  // Generate briefings in parallel batches
  console.log(`[DigestV2] User ${userId}: Generating ${groupRecords.length} briefings (batches of ${BRIEFING_BATCH_SIZE})...`);

  for (let i = 0; i < groupRecords.length; i += BRIEFING_BATCH_SIZE) {
    const batch = groupRecords.slice(i, i + BRIEFING_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (gr) => {
        const groupArticleData = ungrouped
          .filter((ua) => gr.articleIds.includes(ua.article.id))
          .map((ua) => ({
            title: ua.article.title,
            cleanText: ua.article.cleanText,
            content: ua.article.content,
            url: ua.article.url,
            publishedAt: ua.article.publishedAt,
            author: ua.article.author,
            entities: ua.article.entities.map((e) => ({ type: e.type, name: e.name })),
            signals: ua.article.articleSignals.map((as) => ({
              slug: as.industrySignal.slug,
              name: as.industrySignal.name,
            })),
          }));

        const briefing = await generateGroupBriefing({
          groupTitle: gr.title,
          articles: groupArticleData,
        });

        if (briefing) {
          await prisma.newsGroup.update({
            where: { id: gr.groupId },
            data: {
              title: briefing.title,
              synopsis: briefing.synopsis,
              executiveSummary: briefing.executiveSummary,
              impactAnalysis: briefing.impactAnalysis,
              actionability: briefing.actionability,
              caseType: briefing.caseType,
            },
          });
          return true;
        }
        return false;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) result.summarized++;
    }
  }

  // Generate period reports (1d, 7d, 30d) in parallel — cached for frontend
  console.log(`[DigestV2] User ${userId}: Generating period reports (parallel)...`);
  try {
    await Promise.allSettled([
      generatePeriodReport(prisma, userId, "1d"),
      generatePeriodReport(prisma, userId, "7d"),
      generatePeriodReport(prisma, userId, "30d"),
    ]);
    console.log(`[DigestV2] User ${userId}: Period reports generated.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DigestV2] Period report generation failed: ${msg}`);
  }
}

function isDuplicateError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Unique constraint failed")
  );
}

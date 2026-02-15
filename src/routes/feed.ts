import type { FastifyInstance } from "fastify";

export default async function feedRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("onRequest", app.authenticate);

  // GET /api/feed — get user's matched articles (paginated)
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    "/api/feed",
    async (request) => {
      const { userId } = request.user;
      const page = Math.max(1, parseInt(request.query.page || "1", 10));
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || "20", 10)));
      const skip = (page - 1) * limit;

      const [articles, total] = await Promise.all([
        app.prisma.userArticle.findMany({
          where: { userId, matched: true },
          include: {
            article: {
              include: { source: { select: { id: true, name: true, url: true } } },
            },
          },
          orderBy: { article: { scrapedAt: "desc" } },
          skip,
          take: limit,
        }),
        app.prisma.userArticle.count({ where: { userId, matched: true } }),
      ]);

      return {
        articles: articles.map((ua) => ({
          id: ua.article.id,
          title: ua.article.title,
          url: ua.article.url,
          summary: ua.article.summary,
          publishedAt: ua.article.publishedAt,
          scrapedAt: ua.article.scrapedAt,
          source: ua.article.source,
          matchedKeywords: ua.matchedKeywords,
          read: ua.read,
          sent: ua.sent,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // GET /api/feed/:id — get single article with full content
  app.get<{ Params: { id: string } }>("/api/feed/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const userArticle = await app.prisma.userArticle.findFirst({
      where: { userId, articleId: id },
      include: {
        article: {
          include: { source: { select: { id: true, name: true, url: true } } },
        },
      },
    });

    if (!userArticle) {
      return reply.status(404).send({ error: "Article not found" });
    }

    // Mark as read
    if (!userArticle.read) {
      await app.prisma.userArticle.update({
        where: { id: userArticle.id },
        data: { read: true },
      });
    }

    return {
      id: userArticle.article.id,
      title: userArticle.article.title,
      url: userArticle.article.url,
      content: userArticle.article.content,
      summary: userArticle.article.summary,
      publishedAt: userArticle.article.publishedAt,
      scrapedAt: userArticle.article.scrapedAt,
      source: userArticle.article.source,
      matchedKeywords: userArticle.matchedKeywords,
      read: true,
      sent: userArticle.sent,
    };
  });

  // ──────────────────────────────────────────
  // V2: Grouped intelligence feed
  // ──────────────────────────────────────────

  // GET /api/feed/brief — grouped intelligence feed with period filter
  app.get<{ Querystring: { date?: string; period?: string; page?: string; limit?: string } }>(
    "/api/feed/brief",
    async (request, reply) => {
      const { userId } = request.user;
      const page = Math.max(1, parseInt(request.query.page || "1", 10));
      const limit = Math.min(20, Math.max(1, parseInt(request.query.limit || "10", 10)));
      const skip = (page - 1) * limit;

      // Period filter takes precedence over legacy 'date' param
      const periodDays: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30 };
      let dateFilter: Date;

      if (request.query.period) {
        const days = periodDays[request.query.period];
        if (!days) {
          return reply.status(400).send({ error: "Invalid period. Use 1d, 7d, or 30d." });
        }
        dateFilter = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      } else if (request.query.date) {
        dateFilter = new Date(request.query.date);
      } else {
        dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      }

      // Filter by article publishedAt (real-world date), not group createdAt
      const whereClause = {
        userId,
        userArticles: {
          some: {
            article: { publishedAt: { gte: dateFilter } },
          },
        },
      };

      const [groups, total] = await Promise.all([
        app.prisma.newsGroup.findMany({
          where: whereClause,
          include: {
            _count: { select: { userArticles: true } },
            userArticles: {
              include: {
                article: {
                  include: {
                    source: { select: { id: true, name: true, url: true } },
                    entities: { select: { type: true, name: true, confidence: true } },
                    articleSignals: {
                      include: { industrySignal: { select: { name: true, slug: true } } },
                    },
                  },
                },
              },
              take: 3, // Preview: first 3 articles
              orderBy: { article: { publishedAt: "desc" } },
            },
          },
          orderBy: [{ caseType: "asc" }, { date: "desc" }], // Critical (1) first, then by date
          skip,
          take: limit,
        }),
        app.prisma.newsGroup.count({ where: whereClause }),
      ]);

      return {
        groups: groups.map((g) => ({
          id: g.id,
          title: g.title,
          synopsis: g.synopsis,
          executiveSummary: g.executiveSummary,
          impactAnalysis: g.impactAnalysis,
          actionability: g.actionability,
          caseType: g.caseType,
          confidence: g.confidence,
          date: g.date,
          articleCount: g._count.userArticles,
          articles: g.userArticles.map((ua) => ({
            id: ua.article.id,
            title: ua.article.title,
            url: ua.article.url,
            publishedAt: ua.article.publishedAt,
            source: ua.article.source,
            entities: ua.article.entities,
            signals: ua.article.articleSignals.map((as) => ({
              name: as.industrySignal.name,
              slug: as.industrySignal.slug,
              confidence: as.confidence,
            })),
          })),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // GET /api/feed/brief/report — cached period intelligence report
  app.get<{ Querystring: { period?: string } }>(
    "/api/feed/brief/report",
    async (request, reply) => {
      const { userId } = request.user;
      const period = request.query.period || "7d";

      if (!["1d", "7d", "30d"].includes(period)) {
        return reply.status(400).send({ error: "Invalid period. Use 1d, 7d, or 30d." });
      }

      const report = await app.prisma.periodReport.findUnique({
        where: { userId_period: { userId, period } },
      });

      if (!report) {
        return reply.status(404).send({
          error: "No report available yet. Reports are generated after each digest run.",
        });
      }

      return {
        period: report.period,
        fromDate: report.fromDate,
        toDate: report.toDate,
        summary: report.summary,
        stats: report.stats,
        generatedAt: report.generatedAt,
      };
    }
  );

  // POST /api/feed/brief/reset — clear all groups so next digest re-clusters fresh
  app.post("/api/feed/brief/reset", async (request) => {
    const { userId } = request.user;

    // Unlink all userArticles from their groups
    await app.prisma.userArticle.updateMany({
      where: { userId, newsGroupId: { not: null } },
      data: { newsGroupId: null },
    });

    // Delete all groups for this user
    const deleted = await app.prisma.newsGroup.deleteMany({
      where: { userId },
    });

    // Reset entitiesExtracted so entities + signals get re-extracted too
    const userArticleIds = await app.prisma.userArticle.findMany({
      where: { userId, matched: true },
      select: { articleId: true },
    });
    await app.prisma.article.updateMany({
      where: { id: { in: userArticleIds.map((ua) => ua.articleId) } },
      data: { entitiesExtracted: false },
    });

    return {
      message: `Cleared ${deleted.count} groups. Run digest again to re-cluster with updated algorithm.`,
    };
  });

  // GET /api/feed/groups/:id — single group with full article details
  app.get<{ Params: { id: string } }>(
    "/api/feed/groups/:id",
    async (request, reply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const group = await app.prisma.newsGroup.findFirst({
        where: { id, userId },
        include: {
          userArticles: {
            include: {
              article: {
                include: {
                  source: { select: { id: true, name: true, url: true } },
                  entities: {
                    select: { type: true, name: true, confidence: true },
                    orderBy: { confidence: "desc" },
                  },
                  articleSignals: {
                    include: { industrySignal: { select: { name: true, slug: true } } },
                    orderBy: { confidence: "desc" },
                  },
                },
              },
            },
            orderBy: { article: { publishedAt: "desc" } },
          },
        },
      });

      if (!group) {
        return reply.status(404).send({ error: "Group not found" });
      }

      // Mark all articles in this group as read
      const unreadIds = group.userArticles
        .filter((ua) => !ua.read)
        .map((ua) => ua.id);
      if (unreadIds.length > 0) {
        await app.prisma.userArticle.updateMany({
          where: { id: { in: unreadIds } },
          data: { read: true },
        });
      }

      return {
        id: group.id,
        title: group.title,
        synopsis: group.synopsis,
        executiveSummary: group.executiveSummary,
        impactAnalysis: group.impactAnalysis,
        actionability: group.actionability,
        caseType: group.caseType,
        confidence: group.confidence,
        date: group.date,
        articles: group.userArticles.map((ua) => ({
          id: ua.article.id,
          title: ua.article.title,
          url: ua.article.url,
          content: ua.article.content,
          cleanText: ua.article.cleanText,
          summary: ua.article.summary,
          publishedAt: ua.article.publishedAt,
          author: ua.article.author,
          source: ua.article.source,
          entities: ua.article.entities,
          signals: ua.article.articleSignals.map((as) => ({
            name: as.industrySignal.name,
            slug: as.industrySignal.slug,
            confidence: as.confidence,
          })),
          matchedKeywords: ua.matchedKeywords,
          read: true,
        })),
      };
    }
  );
}

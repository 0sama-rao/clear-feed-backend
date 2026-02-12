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
}

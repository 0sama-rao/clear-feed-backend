import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export default async function adminRoutes(app: FastifyInstance) {
  // All routes require authentication + admin role
  app.addHook("onRequest", app.authenticate);
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user.role !== "ADMIN") {
      return reply.status(403).send({ error: "Admin access required" });
    }
  });

  // GET /api/admin/users — list all users
  app.get("/api/admin/users", async () => {
    const users = await app.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        _count: { select: { sources: true, keywords: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role.toLowerCase(),
      createdAt: u.createdAt,
      sourcesCount: u._count.sources,
      keywordsCount: u._count.keywords,
    }));
  });

  // GET /api/admin/stats — platform stats
  app.get("/api/admin/stats", async () => {
    const [totalUsers, totalSources, totalKeywords, totalArticles, totalMatched] =
      await Promise.all([
        app.prisma.user.count(),
        app.prisma.source.count(),
        app.prisma.keyword.count(),
        app.prisma.article.count(),
        app.prisma.userArticle.count({ where: { matched: true } }),
      ]);

    return { totalUsers, totalSources, totalKeywords, totalArticles, totalMatched };
  });
}

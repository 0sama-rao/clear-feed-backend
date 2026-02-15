import type { FastifyInstance } from "fastify";

export default async function onboardingRoutes(app: FastifyInstance) {
  // GET /api/onboarding/industries — list available industries
  app.get("/api/onboarding/industries", async (_request, reply) => {
    const industries = await app.prisma.industry.findMany({
      include: {
        signals: {
          select: { id: true, name: true, slug: true, description: true },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    return reply.send({ industries });
  });

  // POST /api/onboarding — select industry + auto-populate sources & keywords
  app.post("/api/onboarding", {
    onRequest: app.authenticate,
    handler: async (request, reply) => {
      const { userId } = request.user;
      const { industrySlug } = request.body as { industrySlug: string };

      if (!industrySlug || typeof industrySlug !== "string") {
        return reply.status(400).send({ error: "industrySlug is required" });
      }

      // Look up industry
      const industry = await app.prisma.industry.findUnique({
        where: { slug: industrySlug },
        include: {
          defaultSources: true,
          defaultKeywords: true,
        },
      });

      if (!industry) {
        return reply.status(404).send({ error: "Industry not found" });
      }

      // Check if already onboarded
      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { onboarded: true, industryId: true },
      });

      if (user?.onboarded && user?.industryId === industry.id) {
        return reply.send({
          message: "Already onboarded",
          industry: { id: industry.id, name: industry.name, slug: industry.slug },
          sourcesAdded: 0,
          keywordsAdded: 0,
        });
      }

      // Update user with industry
      await app.prisma.user.update({
        where: { id: userId },
        data: { industryId: industry.id, onboarded: true },
      });

      // Copy default sources (skip duplicates by URL)
      const existingSources = await app.prisma.source.findMany({
        where: { userId },
        select: { url: true },
      });
      const existingUrls = new Set(existingSources.map((s) => s.url));

      let sourcesAdded = 0;
      for (const ds of industry.defaultSources) {
        if (existingUrls.has(ds.url)) continue;
        await app.prisma.source.create({
          data: {
            userId,
            url: ds.url,
            name: ds.name,
            type: ds.type,
            active: true,
          },
        });
        sourcesAdded++;
      }

      // Copy default keywords (skip duplicates by word)
      const existingKeywords = await app.prisma.keyword.findMany({
        where: { userId },
        select: { word: true },
      });
      const existingWords = new Set(existingKeywords.map((k) => k.word.toLowerCase()));

      let keywordsAdded = 0;
      for (const dk of industry.defaultKeywords) {
        if (existingWords.has(dk.word.toLowerCase())) continue;
        await app.prisma.keyword.create({
          data: {
            userId,
            word: dk.word.toLowerCase(),
          },
        });
        keywordsAdded++;
      }

      app.log.info(
        `User ${userId} onboarded to ${industry.name}: ${sourcesAdded} sources, ${keywordsAdded} keywords added`
      );

      return reply.send({
        message: "Onboarding complete",
        industry: { id: industry.id, name: industry.name, slug: industry.slug },
        sourcesAdded,
        keywordsAdded,
      });
    },
  });
}

import type { FastifyInstance } from "fastify";

export default async function keywordsRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("onRequest", app.authenticate);

  // GET /api/keywords — list user's keywords
  app.get("/api/keywords", async (request) => {
    const { userId } = request.user;
    const keywords = await app.prisma.keyword.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return keywords;
  });

  // POST /api/keywords — add a keyword
  app.post("/api/keywords", async (request, reply) => {
    const { userId } = request.user;
    const { word } = request.body as { word: string };

    if (!word || !word.trim()) {
      return reply.status(400).send({ error: "word is required" });
    }

    // Check for duplicate keyword for this user
    const existing = await app.prisma.keyword.findFirst({
      where: { userId, word: word.trim().toLowerCase() },
    });
    if (existing) {
      return reply.status(409).send({ error: "Keyword already exists" });
    }

    const keyword = await app.prisma.keyword.create({
      data: { word: word.trim().toLowerCase(), userId },
    });

    return reply.status(201).send(keyword);
  });

  // DELETE /api/keywords/:id — remove a keyword
  app.delete<{ Params: { id: string } }>("/api/keywords/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const keyword = await app.prisma.keyword.findUnique({ where: { id } });
    if (!keyword || keyword.userId !== userId) {
      return reply.status(404).send({ error: "Keyword not found" });
    }

    await app.prisma.keyword.delete({ where: { id } });
    return reply.status(204).send();
  });
}

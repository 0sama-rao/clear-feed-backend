import type { FastifyInstance } from "fastify";

export default async function sourcesRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("onRequest", app.authenticate);

  // GET /api/sources — list user's sources
  app.get("/api/sources", async (request) => {
    const { userId } = request.user;
    const sources = await app.prisma.source.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return sources;
  });

  // POST /api/sources — add a new source
  app.post("/api/sources", async (request, reply) => {
    const { userId } = request.user;
    const { url, name, type } = request.body as {
      url: string;
      name: string;
      type: "RSS" | "WEBSITE";
    };

    if (!url || !name || !type) {
      return reply.status(400).send({ error: "url, name, and type are required" });
    }

    if (!["RSS", "WEBSITE"].includes(type)) {
      return reply.status(400).send({ error: "type must be RSS or WEBSITE" });
    }

    const source = await app.prisma.source.create({
      data: { url, name, type, userId },
    });

    return reply.status(201).send(source);
  });

  // PUT /api/sources/:id — update a source
  app.put<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;
    const { url, name, type, active } = request.body as {
      url?: string;
      name?: string;
      type?: "RSS" | "WEBSITE";
      active?: boolean;
    };

    const source = await app.prisma.source.findUnique({ where: { id } });
    if (!source || source.userId !== userId) {
      return reply.status(404).send({ error: "Source not found" });
    }

    if (type && !["RSS", "WEBSITE"].includes(type)) {
      return reply.status(400).send({ error: "type must be RSS or WEBSITE" });
    }

    const updated = await app.prisma.source.update({
      where: { id },
      data: {
        ...(url !== undefined && { url }),
        ...(name !== undefined && { name }),
        ...(type !== undefined && { type }),
        ...(active !== undefined && { active }),
      },
    });

    return updated;
  });

  // DELETE /api/sources/:id — remove a source
  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const source = await app.prisma.source.findUnique({ where: { id } });
    if (!source || source.userId !== userId) {
      return reply.status(404).send({ error: "Source not found" });
    }

    await app.prisma.source.delete({ where: { id } });
    return reply.status(204).send();
  });
}

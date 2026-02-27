import type { FastifyInstance } from "fastify";
import { computeRemediationMetrics } from "../services/remediationTracker.js";

export default async function exposureRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // GET /api/exposure — list user's CVE exposures (paginated, filterable)
  app.get("/api/exposure", async (request) => {
    const { userId } = request.user;
    const { state, severity, page, limit, sort } = request.query as {
      state?: string;
      severity?: string;
      page?: string;
      limit?: string;
      sort?: string;
    };

    const pageNum = parseInt(page || "1", 10);
    const pageSize = Math.min(parseInt(limit || "20", 10), 100);

    const where: any = { userId };
    if (state) where.exposureState = state;
    if (severity) {
      where.articleCve = { severity: severity.toUpperCase() };
    }

    const [exposures, total] = await Promise.all([
      app.prisma.userCVEExposure.findMany({
        where,
        include: {
          articleCve: {
            select: {
              cveId: true,
              cvssScore: true,
              severity: true,
              description: true,
              inKEV: true,
              kevDueDate: true,
            },
          },
          techStackItem: {
            select: {
              vendor: true,
              product: true,
              version: true,
              category: true,
            },
          },
        },
        orderBy:
          sort === "cvss"
            ? { articleCve: { cvssScore: "desc" } }
            : { firstDetectedAt: "desc" },
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
      app.prisma.userCVEExposure.count({ where }),
    ]);

    return {
      data: exposures,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });

  // GET /api/exposure/stats — summary counts
  app.get("/api/exposure/stats", async (request) => {
    const { userId } = request.user;
    return computeRemediationMetrics(app.prisma, userId);
  });

  // GET /api/exposure/overdue — overdue vulnerable CVEs
  app.get("/api/exposure/overdue", async (request) => {
    const { userId } = request.user;
    const now = new Date();

    const overdue = await app.prisma.userCVEExposure.findMany({
      where: {
        userId,
        exposureState: "VULNERABLE",
        remediationDeadline: { lt: now },
      },
      include: {
        articleCve: {
          select: {
            cveId: true,
            cvssScore: true,
            severity: true,
            inKEV: true,
            kevDueDate: true,
          },
        },
        techStackItem: {
          select: { vendor: true, product: true, version: true },
        },
      },
      orderBy: { remediationDeadline: "asc" },
    });

    return overdue;
  });

  // GET /api/exposure/:cveId — single exposure detail
  app.get<{ Params: { cveId: string } }>(
    "/api/exposure/:cveId",
    async (request, reply) => {
      const { userId } = request.user;
      const { cveId } = request.params;

      const exposure = await app.prisma.userCVEExposure.findUnique({
        where: { userId_cveId: { userId, cveId } },
        include: {
          articleCve: true,
          techStackItem: true,
        },
      });

      if (!exposure) {
        return reply.status(404).send({ error: "Exposure not found" });
      }

      return exposure;
    }
  );

  // PUT /api/exposure/:cveId — manual override of exposure state
  app.put<{ Params: { cveId: string } }>(
    "/api/exposure/:cveId",
    async (request, reply) => {
      const { userId } = request.user;
      const { cveId } = request.params;
      const { exposureState, notes } = request.body as {
        exposureState: string;
        notes?: string;
      };

      const valid = ["VULNERABLE", "FIXED", "NOT_APPLICABLE", "INDIRECT"];
      if (!valid.includes(exposureState)) {
        return reply
          .status(400)
          .send({ error: `exposureState must be one of: ${valid.join(", ")}` });
      }

      const existing = await app.prisma.userCVEExposure.findUnique({
        where: { userId_cveId: { userId, cveId } },
      });

      if (!existing) {
        return reply.status(404).send({ error: "Exposure not found" });
      }

      const updated = await app.prisma.userCVEExposure.update({
        where: { userId_cveId: { userId, cveId } },
        data: {
          exposureState: exposureState as any,
          autoClassified: false,
          ...(notes !== undefined && { notes }),
          ...(exposureState === "FIXED" && !existing.patchedAt && { patchedAt: new Date() }),
        },
      });

      return updated;
    }
  );

  // POST /api/exposure/:cveId/patch — mark CVE as patched
  app.post<{ Params: { cveId: string } }>(
    "/api/exposure/:cveId/patch",
    async (request, reply) => {
      const { userId } = request.user;
      const { cveId } = request.params;
      const { patchedAt } = request.body as { patchedAt?: string };

      const existing = await app.prisma.userCVEExposure.findUnique({
        where: { userId_cveId: { userId, cveId } },
      });

      if (!existing) {
        return reply.status(404).send({ error: "Exposure not found" });
      }

      const updated = await app.prisma.userCVEExposure.update({
        where: { userId_cveId: { userId, cveId } },
        data: {
          exposureState: "FIXED",
          patchedAt: patchedAt ? new Date(patchedAt) : new Date(),
          autoClassified: false,
        },
      });

      return updated;
    }
  );

  // GET /api/exposure/by-stack/:itemId — exposures for a specific tech stack item
  app.get<{ Params: { itemId: string } }>(
    "/api/exposure/by-stack/:itemId",
    async (request, reply) => {
      const { userId } = request.user;
      const { itemId } = request.params;

      const item = await app.prisma.techStackItem.findUnique({
        where: { id: itemId },
      });
      if (!item || item.userId !== userId) {
        return reply.status(404).send({ error: "Tech stack item not found" });
      }

      const exposures = await app.prisma.userCVEExposure.findMany({
        where: { userId, techStackItemId: itemId },
        include: {
          articleCve: {
            select: {
              cveId: true,
              cvssScore: true,
              severity: true,
              description: true,
              inKEV: true,
              kevDueDate: true,
            },
          },
        },
        orderBy: { firstDetectedAt: "desc" },
      });

      return exposures;
    }
  );
}

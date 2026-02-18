import type { FastifyInstance } from "fastify";

const VALID_FREQUENCIES = ["1h", "3h", "6h", "12h", "1d", "3d", "7d"];

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // GET /api/settings — return current user settings
  app.get("/api/settings", async (request) => {
    const { userId } = request.user;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: {
        digestFrequency: true,
        digestTime: true,
        emailEnabled: true,
        lastDigestAt: true,
        email: true,
      },
    });

    if (!user) {
      return { error: "User not found" };
    }

    return {
      digestFrequency: user.digestFrequency,
      digestTime: user.digestTime,
      emailEnabled: user.emailEnabled,
      lastDigestAt: user.lastDigestAt,
      email: user.email,
    };
  });

  // PUT /api/settings — update user settings
  app.put("/api/settings", async (request, reply) => {
    const { userId } = request.user;
    const body = request.body as {
      digestFrequency?: string;
      digestTime?: string;
      emailEnabled?: boolean;
    } | null;

    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { digestFrequency, digestTime, emailEnabled } = body;

    // Validate digestFrequency
    if (digestFrequency !== undefined && !VALID_FREQUENCIES.includes(digestFrequency)) {
      return reply.status(400).send({
        error: `Invalid digestFrequency. Must be one of: ${VALID_FREQUENCIES.join(", ")}`,
      });
    }

    // Validate digestTime format (HH:MM)
    if (digestTime !== undefined) {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (!timeRegex.test(digestTime)) {
        return reply.status(400).send({
          error: "Invalid digestTime. Must be in HH:MM format (00:00 - 23:59)",
        });
      }
    }

    // Validate emailEnabled
    if (emailEnabled !== undefined && typeof emailEnabled !== "boolean") {
      return reply.status(400).send({
        error: "emailEnabled must be a boolean",
      });
    }

    const updated = await app.prisma.user.update({
      where: { id: userId },
      data: {
        ...(digestFrequency !== undefined && { digestFrequency }),
        ...(digestTime !== undefined && { digestTime }),
        ...(emailEnabled !== undefined && { emailEnabled }),
      },
      select: {
        digestFrequency: true,
        digestTime: true,
        emailEnabled: true,
        lastDigestAt: true,
        email: true,
      },
    });

    return {
      message: "Settings updated",
      settings: {
        digestFrequency: updated.digestFrequency,
        digestTime: updated.digestTime,
        emailEnabled: updated.emailEnabled,
        lastDigestAt: updated.lastDigestAt,
        email: updated.email,
      },
    };
  });
}

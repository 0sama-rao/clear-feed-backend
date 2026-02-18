import type { FastifyInstance } from "fastify";
import { runDigestForUser, runDigestForAllUsers } from "../jobs/dailyDigest.js";
import { sendDigestEmail } from "../services/emailService.js";

export default async function digestRoutes(app: FastifyInstance) {
  // Accept any content type on digest routes (no body needed)
  app.addContentTypeParser("application/x-www-form-urlencoded", (_req, _payload, done) => done(null));
  app.addContentTypeParser("text/plain", (_req, _payload, done) => done(null));

  // POST /api/digest/run — manually trigger digest for the logged-in user
  app.post("/api/digest/run", {
    onRequest: app.authenticate,
    handler: async (request, reply) => {
      const { userId } = request.user;

      app.log.info(`Manual digest triggered for user ${userId}`);

      const result = await runDigestForUser(app.prisma, userId);

      // Reset schedule timer so user doesn't get a duplicate scheduled digest
      const user = await app.prisma.user.update({
        where: { id: userId },
        data: { lastDigestAt: new Date() },
        select: { email: true, name: true, emailEnabled: true },
      });

      // Send email if enabled and there are new matched articles
      if (user.emailEnabled && result.matched > 0) {
        await sendDigestEmail(app.prisma, userId, user.email, user.name, result);
      }

      return reply.send({
        message: "Digest completed",
        result: {
          scraped: result.scraped,
          matched: result.matched,
          summarized: result.summarized,
          errors: result.errors,
        },
      });
    },
  });

  // POST /api/digest/run-all — admin only: trigger digest for ALL users
  app.post("/api/digest/run-all", {
    onRequest: app.authenticate,
    handler: async (request, reply) => {
      if (request.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Admin access required" });
      }

      app.log.info("Manual digest triggered for ALL users (admin)");

      const results = await runDigestForAllUsers(app.prisma);

      return reply.send({
        message: "Digest completed for all users",
        results: results.map((r) => ({
          userId: r.userId,
          scraped: r.scraped,
          matched: r.matched,
          summarized: r.summarized,
          errorCount: r.errors.length,
        })),
      });
    },
  });
}

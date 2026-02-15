import Fastify from "fastify";
import cors from "@fastify/cors";
import cron from "node-cron";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import sourcesRoutes from "./routes/sources.js";
import keywordsRoutes from "./routes/keywords.js";
import feedRoutes from "./routes/feed.js";
import adminRoutes from "./routes/admin.js";
import digestRoutes from "./routes/digest.js";
import onboardingRoutes from "./routes/onboarding.js";
import { runDigestForAllUsers } from "./jobs/dailyDigest.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(prismaPlugin);
  await app.register(authPlugin);

  app.get("/api/health", async () => {
    return { status: "ok" };
  });

  await app.register(authRoutes);
  await app.register(sourcesRoutes);
  await app.register(keywordsRoutes);
  await app.register(feedRoutes);
  await app.register(adminRoutes);
  await app.register(digestRoutes);
  await app.register(onboardingRoutes);

  // Daily digest cron — runs every day at 6:00 AM
  cron.schedule("0 6 * * *", async () => {
    app.log.info("Cron: Starting daily digest for all users...");
    try {
      await runDigestForAllUsers(app.prisma);
      app.log.info("Cron: Daily digest completed.");
    } catch (err) {
      app.log.error(err, "Cron: Daily digest failed.");
    }
  });

  return app;
}

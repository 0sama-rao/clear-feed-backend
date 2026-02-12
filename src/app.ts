import Fastify from "fastify";
import cors from "@fastify/cors";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import sourcesRoutes from "./routes/sources.js";
import keywordsRoutes from "./routes/keywords.js";
import feedRoutes from "./routes/feed.js";
import adminRoutes from "./routes/admin.js";

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

  return app;
}

import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

const prisma = new PrismaClient();

export default fp(async (app: FastifyInstance) => {
  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

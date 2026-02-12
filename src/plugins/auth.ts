import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export default fp(async (app: FastifyInstance) => {
  app.register(jwt, {
    secret: process.env.JWT_SECRET || "change-me",
  });

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string; role: string };
    user: { userId: string; role: string };
  }
}

import type { FastifyInstance } from "fastify";
import { hashSync, compareSync } from "bcryptjs";
import { randomUUID } from "crypto";

function formatUser(user: { id: string; email: string; name: string; role: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role.toLowerCase() };
}

export default async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/register
  app.post("/api/auth/register", async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name: string;
    };

    if (!email || !password || !name) {
      return reply.status(400).send({ error: "email, password, and name are required" });
    }

    const existing = await app.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const user = await app.prisma.user.create({
      data: {
        email,
        password: hashSync(password, 10),
        name,
      },
    });

    const tokens = await generateTokens(app, user.id, user.role);
    return reply.status(201).send({ user: formatUser(user), ...tokens });
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (request, reply) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    if (!email || !password) {
      return reply.status(400).send({ error: "email and password are required" });
    }

    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user || !compareSync(password, user.password)) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const tokens = await generateTokens(app, user.id, user.role);
    return reply.send({ user: formatUser(user), ...tokens });
  });

  // POST /api/auth/refresh
  app.post("/api/auth/refresh", async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };

    if (!refreshToken) {
      return reply.status(400).send({ error: "refreshToken is required" });
    }

    const stored = await app.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored || stored.expiresAt < new Date()) {
      if (stored) {
        await app.prisma.refreshToken.delete({ where: { id: stored.id } });
      }
      return reply.status(401).send({ error: "Invalid or expired refresh token" });
    }

    // Delete old refresh token (rotate)
    await app.prisma.refreshToken.delete({ where: { id: stored.id } });

    const tokens = await generateTokens(app, stored.user.id, stored.user.role);
    return reply.send({ user: formatUser(stored.user), ...tokens });
  });
}

async function generateTokens(app: FastifyInstance, userId: string, role: string) {
  const accessToken = app.jwt.sign(
    { userId, role },
    { expiresIn: "15m" }
  );

  const refreshToken = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await app.prisma.refreshToken.create({
    data: { token: refreshToken, userId, expiresAt },
  });

  return { accessToken, refreshToken };
}

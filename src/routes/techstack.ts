import type { FastifyInstance } from "fastify";
import { generateCpePattern } from "../services/cpeMatcher.js";
import { searchCatalog, getCatalogByCategory, TECH_CATALOG } from "../services/techCatalog.js";
import { retroactiveMatchForStackItem } from "../services/cpeMatcher.js";

export default async function techstackRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // GET /api/techstack — list user's tech stack items
  app.get("/api/techstack", async (request) => {
    const { userId } = request.user;
    const items = await app.prisma.techStackItem.findMany({
      where: { userId },
      include: {
        _count: { select: { exposures: true } },
      },
      orderBy: [{ category: "asc" }, { product: "asc" }],
    });
    return items;
  });

  // POST /api/techstack — add a tech stack item
  app.post("/api/techstack", async (request, reply) => {
    const { userId } = request.user;
    const { vendor, product, version, category } = request.body as {
      vendor: string;
      product: string;
      version?: string;
      category?: string;
    };

    if (!vendor || !product) {
      return reply.status(400).send({ error: "vendor and product are required" });
    }

    const validCategories = [
      "EDGE_DEVICE", "NETWORK", "OS", "APPLICATION",
      "CLOUD", "IDENTITY", "DATABASE", "LIBRARY", "OTHER",
    ];
    if (category && !validCategories.includes(category)) {
      return reply.status(400).send({ error: `category must be one of: ${validCategories.join(", ")}` });
    }

    const cpePattern = generateCpePattern(vendor, product);

    try {
      const item = await app.prisma.techStackItem.create({
        data: {
          userId,
          vendor: vendor.toLowerCase().replace(/\s+/g, "_"),
          product: product.toLowerCase().replace(/\s+/g, "_"),
          version: version || null,
          category: (category as any) || "APPLICATION",
          cpePattern,
        },
      });

      // Retroactively match against existing CVEs
      const matched = await retroactiveMatchForStackItem(app.prisma, userId, {
        id: item.id,
        vendor: item.vendor,
        product: item.product,
        version: item.version,
      });

      return reply.status(201).send({ ...item, retroactiveMatches: matched });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Unique constraint")) {
        return reply.status(409).send({ error: "This product is already in your tech stack" });
      }
      throw err;
    }
  });

  // POST /api/techstack/bulk — add multiple items at once
  app.post("/api/techstack/bulk", async (request, reply) => {
    const { userId } = request.user;
    const { items } = request.body as {
      items: Array<{
        vendor: string;
        product: string;
        version?: string;
        category?: string;
      }>;
    };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: "items array is required" });
    }

    let added = 0;
    let skipped = 0;

    for (const item of items) {
      if (!item.vendor || !item.product) {
        skipped++;
        continue;
      }

      const cpePattern = generateCpePattern(item.vendor, item.product);

      try {
        const created = await app.prisma.techStackItem.create({
          data: {
            userId,
            vendor: item.vendor.toLowerCase().replace(/\s+/g, "_"),
            product: item.product.toLowerCase().replace(/\s+/g, "_"),
            version: item.version || null,
            category: (item.category as any) || "APPLICATION",
            cpePattern,
          },
        });

        // Retroactive match for each new item
        await retroactiveMatchForStackItem(app.prisma, userId, {
          id: created.id,
          vendor: created.vendor,
          product: created.product,
          version: created.version,
        });

        added++;
      } catch (err) {
        if (err instanceof Error && err.message.includes("Unique constraint")) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    return reply.status(201).send({ added, skipped });
  });

  // PUT /api/techstack/:id — update a tech stack item
  app.put<{ Params: { id: string } }>("/api/techstack/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;
    const { vendor, product, version, category, active } = request.body as {
      vendor?: string;
      product?: string;
      version?: string;
      category?: string;
      active?: boolean;
    };

    const item = await app.prisma.techStackItem.findUnique({ where: { id } });
    if (!item || item.userId !== userId) {
      return reply.status(404).send({ error: "Tech stack item not found" });
    }

    const newVendor = vendor !== undefined ? vendor.toLowerCase().replace(/\s+/g, "_") : item.vendor;
    const newProduct = product !== undefined ? product.toLowerCase().replace(/\s+/g, "_") : item.product;
    const needsNewCpe = vendor !== undefined || product !== undefined;

    const updated = await app.prisma.techStackItem.update({
      where: { id },
      data: {
        ...(vendor !== undefined && { vendor: newVendor }),
        ...(product !== undefined && { product: newProduct }),
        ...(version !== undefined && { version: version || null }),
        ...(category !== undefined && { category: category as any }),
        ...(active !== undefined && { active }),
        ...(needsNewCpe && { cpePattern: generateCpePattern(newVendor, newProduct) }),
      },
    });

    return updated;
  });

  // DELETE /api/techstack/:id — remove a tech stack item
  app.delete<{ Params: { id: string } }>("/api/techstack/:id", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const item = await app.prisma.techStackItem.findUnique({ where: { id } });
    if (!item || item.userId !== userId) {
      return reply.status(404).send({ error: "Tech stack item not found" });
    }

    await app.prisma.techStackItem.delete({ where: { id } });
    return reply.status(204).send();
  });

  // GET /api/techstack/catalog — browse common products
  app.get("/api/techstack/catalog", async (request) => {
    const { search, category } = request.query as {
      search?: string;
      category?: string;
    };

    if (search) {
      return searchCatalog(search, category);
    }
    if (category) {
      return getCatalogByCategory(category);
    }
    return TECH_CATALOG;
  });
}

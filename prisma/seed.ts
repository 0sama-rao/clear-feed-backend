import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: "admin@clearfeed.com" },
    update: {},
    create: {
      email: "admin@clearfeed.com",
      password: hashSync("admin123", 10),
      name: "Admin",
      role: "ADMIN",
    },
  });

  console.log("Seeded admin user:", admin.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

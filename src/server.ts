import "dotenv/config";
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();

import type { PrismaClient } from "@prisma/client";
import { runDigestForUser } from "./dailyDigest.js";
import { sendDigestEmail } from "../services/emailService.js";
import { prewarmFeedCache } from "../services/scraper.js";

/** Map frequency strings to milliseconds */
const FREQUENCY_MS: Record<string, number> = {
  "1h":  1 * 60 * 60 * 1000,
  "3h":  3 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d":  24 * 60 * 60 * 1000,
  "3d":  3 * 24 * 60 * 60 * 1000,
  "7d":  7 * 24 * 60 * 60 * 1000,
};

/**
 * Checks which users are due for a digest and runs it for each.
 * Called every hour by the cron scheduler in app.ts.
 */
export async function runScheduledDigests(prisma: PrismaClient): Promise<void> {
  const now = new Date();
  const currentHour = now.getUTCHours();

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      digestFrequency: true,
      lastDigestAt: true,
      digestTime: true,
      emailEnabled: true,
    },
  });

  console.log(`[Scheduler] Checking ${users.length} users at ${now.toISOString()}...`);

  const dueUsers = users.filter((user) => {
    const intervalMs = FREQUENCY_MS[user.digestFrequency];
    if (!intervalMs) return false;

    // Never run before → due immediately
    if (!user.lastDigestAt) return true;

    const elapsed = now.getTime() - user.lastDigestAt.getTime();

    // For daily or longer intervals, also check preferred hour (UTC)
    if (intervalMs >= FREQUENCY_MS["1d"]) {
      const [preferredHour] = user.digestTime.split(":").map(Number);
      if (currentHour !== preferredHour) return false;
    }

    return elapsed >= intervalMs;
  });

  console.log(`[Scheduler] ${dueUsers.length} user(s) due for digest.`);

  // Pre-warm feed cache: scrape each unique RSS URL once for all due users
  if (dueUsers.length > 0) {
    await prewarmFeedCache(prisma, dueUsers.map((u) => u.id));
  }

  for (const user of dueUsers) {
    console.log(`[Scheduler] Running digest for ${user.email} (frequency: ${user.digestFrequency})`);
    try {
      const result = await runDigestForUser(prisma, user.id);

      // Update lastDigestAt
      await prisma.user.update({
        where: { id: user.id },
        data: { lastDigestAt: now },
      });

      console.log(
        `[Scheduler] Digest done for ${user.email}: ${result.scraped} scraped, ${result.matched} matched, ${result.summarized} summarized`
      );

      // Send email if enabled and there are new matched articles
      if (user.emailEnabled && result.matched > 0) {
        await sendDigestEmail(prisma, user.id, user.email, user.name, result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Failed for user ${user.email}: ${message}`);
    }
  }

  console.log(`[Scheduler] Scheduled digest run complete.`);
}

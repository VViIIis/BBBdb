/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync-sales.yml). Run with `npm run sync:sales`.
 * The actual logic lives in src/lib/jobs/syncSales.ts.
 *
 * Pass SEASON_SLUG=bbb4 to target a specific season, or leave it unset to
 * sync whichever Season row has isActive=true.
 */
import "dotenv/config";
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";
import { runSyncSales } from "../src/lib/jobs/syncSales";

// Same rationale as sync-leaderboard.ts's watchdog: force a loud, fast
// failure instead of an unbounded hang burning CI minutes silently.
const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  writeSync(2, `[sync-sales] WATCHDOG: still running after ${WATCHDOG_MS}ms, forcing exit\n`);
  process.exit(1);
}, WATCHDOG_MS);

async function main() {
  const result = await runSyncSales(process.env.SEASON_SLUG);
  writeSync(1, `[sync-sales] wrote ${result.written} sales\n`);
}

main()
  .catch((err) => {
    writeSync(2, `[sync-sales] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    return prisma.$disconnect();
  });

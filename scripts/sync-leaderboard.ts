/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync.yml). Run with `npm run sync:leaderboard`.
 * The actual logic lives in src/lib/jobs/syncLeaderboard.ts so it can be
 * shared with /api/sync (used by Vercel Cron in production).
 */
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";
import { runSyncLeaderboard } from "../src/lib/jobs/syncLeaderboard";

// Hard ceiling on the whole run: if anything hangs (a stuck DB connection,
// a stalled API call) with no error and no timeout of its own, this forces
// a loud, fast failure instead of the job silently running for hours (and
// burning GitHub Actions minutes) with nothing in the log.
const WATCHDOG_MS = 60000;
const watchdog = setTimeout(() => {
  writeSync(2, `[sync-leaderboard] WATCHDOG: still running after ${WATCHDOG_MS}ms, forcing exit\n`);
  process.exit(1);
}, WATCHDOG_MS);

async function main() {
  const { gameweek, written } = await runSyncLeaderboard();
  writeSync(1, `[sync-leaderboard] wrote ${written} team snapshots for ${gameweek}\n`);
}

main()
  .catch((err) => {
    writeSync(2, `[sync-leaderboard] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    return prisma.$disconnect();
  });

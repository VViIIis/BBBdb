import "dotenv/config";
/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync.yml). Run with `npm run sync:leaderboard`.
 * The actual logic lives in src/lib/jobs/syncLeaderboard.ts so it can be
 * shared with /api/sync (used by Vercel Cron in production).
 */
import { prisma } from "../src/lib/db";
import { runSyncLeaderboard } from "../src/lib/jobs/syncLeaderboard";

async function main() {
  const { gameweek, written } = await runSyncLeaderboard();
  console.log(`[sync-leaderboard] wrote ${written} team snapshots for ${gameweek}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync-scores.yml). Run with `npm run sync:scores`.
 * The actual logic lives in src/lib/jobs/syncScores.ts.
 *
 * Powers the /scores tab (SBS "Team Positions" box scores for every real
 * NFL game). Light compared to sync-standings.ts/sync-sbs-trades.ts — at
 * most ~32 games in scope (current + previous week) and only newly-final
 * ones ever trigger a box-score fetch — so a generous watchdog isn't
 * expected to matter here, but every other sync script in this repo has
 * one and a run against a slow/rate-limited ESPN is exactly the kind of
 * silent-hang risk it exists for.
 *
 * No `dotenv/config` import, same reasoning as the other sync scripts:
 * `dotenv` isn't a declared dependency (404s under a clean `npm ci`); `tsx`
 * auto-loads `.env` locally, GitHub Actions injects DATABASE_URL directly.
 */
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";
import { runSyncScores } from "../src/lib/jobs/syncScores";

const WATCHDOG_MS = 15 * 60 * 1000;
const watchdog = setTimeout(() => {
  writeSync(2, `[sync-scores] WATCHDOG: still running after ${WATCHDOG_MS}ms, forcing exit\n`);
  process.exit(1);
}, WATCHDOG_MS);

async function main() {
  const result = await runSyncScores();
  writeSync(
    1,
    `[sync-scores] ${result.games} games synced, ${result.scored} newly scored, ${result.failed} failed\n`,
  );
}

main()
  .catch((err) => {
    writeSync(2, `[sync-scores] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    return prisma.$disconnect();
  });

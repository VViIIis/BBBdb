/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync-standings.yml). Run with `npm run sync:standings`.
 * The actual logic lives in src/lib/jobs/syncStandings.ts.
 *
 * This is the FULL score-coverage sync — it walks every pod (draftId) via
 * /api/standings instead of relying on /api/leaderboard's top-500-global cap
 * (see src/lib/sbsApi.ts's docblock for why that matters: without this, an
 * owner's page only shows scores for whichever of their teams happens to
 * crack the global top 500). Much heavier than sync-leaderboard.ts (~1500
 * HTTP calls vs. a handful), so give it real headroom and don't run it as
 * often — every couple hours is plenty; roster/score standings don't need
 * per-minute freshness the way "what's #1 right now" arguably does.
 *
 * No `dotenv/config` import here, same reasoning as sync-sales.ts: `dotenv`
 * isn't a declared dependency, so that import 404s under a clean `npm ci`.
 * `tsx` auto-loads `.env` locally; GitHub Actions injects DATABASE_URL
 * directly via the workflow's `env:` block.
 */
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";
import { runSyncStandings } from "../src/lib/jobs/syncStandings";

// Same rationale as sync-leaderboard.ts's watchdog, just a longer ceiling —
// this run makes ~1500 HTTP calls (vs. a handful), so it legitimately takes
// longer. Force a loud, fast failure instead of an unbounded hang burning CI
// minutes silently if sbsfantasy.com starts responding slowly or hangs.
//
// Raised from an initial 9 minutes after a real run showed why that was too
// tight: sbsfantasy.com rate-limited the crawl hard enough that retry
// backoff (see withRetry() in syncStandings.ts) added several minutes on
// its own, and then writing ~13,810 team+score rows (2 upserts each, 15 at
// a time) to a remote pooled Postgres took several minutes more — the
// watchdog fired mid-write, having only gotten through 5,400/13,810 rows.
// Nothing was corrupted (every write that DID complete is a real upsert
// already committed — a partial run just means the next run has more left
// to do), but the run itself needs real headroom to finish clean. 20
// minutes leaves comfortable margin under the GitHub Actions workflow's own
// `timeout-minutes: 25` (see .github/workflows/sync-standings.yml).
const WATCHDOG_MS = 20 * 60 * 1000;
const watchdog = setTimeout(() => {
  writeSync(2, `[sync-standings] WATCHDOG: still running after ${WATCHDOG_MS}ms, forcing exit\n`);
  process.exit(1);
}, WATCHDOG_MS);

async function main() {
  const result = await runSyncStandings();
  writeSync(1, `[sync-standings] gameweek ${result.gameweek}: ${result.pods} live pods, wrote ${result.written} rows\n`);
}

main()
  .catch((err) => {
    writeSync(2, `[sync-standings] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    return prisma.$disconnect();
  });

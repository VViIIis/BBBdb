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
// its own, and then writing ~13,810 team+score rows (2 upserts each) to a
// remote pooled Postgres took several minutes more.
//
// Raised AGAIN 2026-09-16, from 20 to 40 minutes, alongside lowering
// syncStandings.ts's WRITE_BATCH (15 -> 5): that change was to stop
// overwhelming the Supabase free-tier project's compute (a burst of
// 15-wide parallel upserts had been pushing the project into an
// "unhealthy" state mid-run — see that file's own comment). It worked —
// the very next run had zero DB connection errors — but 5-wide batches
// naturally take longer for the same ~13,800 rows, and the OLD 20-minute
// watchdog fired mid-write (having only gotten through 5,850/13,808 rows)
// before the run could finish clean.
//
// Raised AGAIN 2026-09-23, from 40 to 75 minutes: 40 minutes turned out to
// be an underestimate, not a fix — a real run got to 11,550/13,727 rows
// (84%) before the watchdog fired, which works out to the SAME ~289
// rows/min write rate the 2026-09-16 run showed (5,850/20min). At that
// rate the full write loop alone needs ~47.5 minutes, before even counting
// the ~1500-call discovery walk and owner-upsert batches that run before
// it — so 40 minutes was always going to come up short, it just took until
// the roster grew enough to notice. 75 minutes leaves real headroom (not
// just enough for today's ~13,700 rows, but room to keep growing for a
// while) rather than another marginal bump that needs revisiting again in
// a few weeks. Keep .github/workflows/sync-standings.yml's own
// `timeout-minutes` comfortably above this one if either needs adjusting
// again (GitHub Actions' hosted-runner hard cap is 360 minutes, so there's
// plenty of room).
const WATCHDOG_MS = 75 * 60 * 1000;
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

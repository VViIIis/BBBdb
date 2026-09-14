/**
 * CLI wrapper for local/manual runs and the GitHub Actions cron
 * (.github/workflows/sync-sbs-trades.yml). Run with `npm run sync:sbs-trades`.
 * The actual logic lives in src/lib/jobs/syncSbsTrades.ts.
 *
 * Fills the gap sync-sales.ts (OpenSea) can't see at all: trades made
 * through SBS's OWN in-app marketplace. See the docblock on
 * getWalletMarketplaceActivity in src/lib/sbsApi.ts for the full story of
 * how that gap was found and confirmed.
 *
 * Makes one call per known wallet (~3,200+ and growing) rather than a
 * handful of collection-wide calls like sync-sales.ts, so it's closer in
 * weight to sync-standings.ts than to sync-sales.ts — starting this job's
 * watchdog/timeout at the SAME generous values that job needed (after two
 * rounds of a real run proving a tighter number too tight) instead of
 * re-learning that lesson from scratch.
 *
 * No `dotenv/config` import here, same reasoning as sync-sales.ts: `dotenv`
 * isn't a declared dependency, so that import 404s under a clean `npm ci`.
 * `tsx` auto-loads `.env` locally; GitHub Actions injects DATABASE_URL
 * directly via the workflow's `env:` block.
 */
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";
import { runSyncSbsTrades } from "../src/lib/jobs/syncSbsTrades";

const WATCHDOG_MS = 20 * 60 * 1000;
const watchdog = setTimeout(() => {
  writeSync(2, `[sync-sbs-trades] WATCHDOG: still running after ${WATCHDOG_MS}ms, forcing exit\n`);
  process.exit(1);
}, WATCHDOG_MS);

async function main() {
  const result = await runSyncSbsTrades();
  writeSync(
    1,
    `[sync-sbs-trades] checked ${result.walletsChecked} wallets, wrote ${result.written} sales (skipped ${result.skippedNoTeam} no-team, ${result.skippedUnusable} unusable)\n`,
  );
}

main()
  .catch((err) => {
    writeSync(2, `[sync-sbs-trades] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    return prisma.$disconnect();
  });

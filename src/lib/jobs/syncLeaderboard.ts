import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import { getCurrentGameweek, getLeaderboard, getUserProfiles, parseTeamName } from "@/lib/sbsApi";

// Plain console.log can sit in an unflushed buffer when stdout is piped (as
// it is under GitHub Actions / most CI), so if the process later hangs and
// gets killed, buffered lines never make it to the log — making a hang look
// like "zero output" even though the code ran well past the log call.
// writeSync bypasses that buffering for these diagnostic checkpoints.
function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

/**
 * Core sync logic, shared by scripts/sync-leaderboard.ts (manual / GitHub
 * Actions cron) and /api/sync (Vercel Cron). Kept small and fast (a handful
 * of HTTP calls + DB upserts) so it comfortably fits inside a serverless
 * function's execution limit — unlike sync-collection.ts, which pages
 * through ~14k NFTs and should stay a standalone script run outside Vercel.
 *
 * sbsfantasy.com's leaderboard API only ever reflects the CURRENT live
 * season, so this always writes into whichever Season has isActive=true —
 * when a new season goes live later, flip that flag and this keeps working
 * with no code change.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[sync] TIMEOUT after ${ms}ms waiting on: ${label}`)), ms)
    ),
  ]);
}

export async function runSyncLeaderboard() {
  log("[sync] looking up active season...");
  const season = await withTimeout(
    prisma.season.findFirst({ where: { isActive: true } }),
    15000,
    "prisma.season.findFirst (initial DB connection)"
  );
  if (!season) {
    throw new Error("No active season found — seed a Season row with isActive=true first.");
  }
  log(`[sync] season: ${season.slug}`);

  const syncLogRow = await prisma.syncLog.create({ data: { source: "sbs-leaderboard" } });
  log("[sync] sync log row created, fetching current gameweek...");
  try {
    const gameweek = await getCurrentGameweek();
    log(`[sync] gameweek: ${gameweek}, fetching leaderboard...`);

    const [bySeason, byWeekly] = await Promise.all([
      getLeaderboard(gameweek, "SeasonScore"),
      getLeaderboard(gameweek, "WeeklyScore"),
    ]);
    log(`[sync] fetched ${bySeason.length} season rows, ${byWeekly.length} weekly rows`);

    const rowsByCardId = new Map<string, (typeof bySeason)[number]>();
    for (const row of [...bySeason, ...byWeekly]) {
      const { cardId } = parseTeamName(row.teamName);
      if (cardId) rowsByCardId.set(cardId, row);
    }
    const rows = [...rowsByCardId.values()];

    const wallets = [...new Set(rows.map((r) => r.ownerWallet))];
    log(`[sync] fetching profiles for ${wallets.length} wallets...`);
    const profiles: Record<string, Awaited<ReturnType<typeof getUserProfiles>>[string]> = {};
    const BATCH = 50;
    for (let i = 0; i < wallets.length; i += BATCH) {
      Object.assign(profiles, await getUserProfiles(wallets.slice(i, i + BATCH)));
    }
    log(`[sync] profiles fetched, writing ${rows.length} rows to DB...`);

    // Writing was previously one row at a time (3 sequential round-trips
    // each) — fine on a low-latency local connection, but ~1500 sequential
    // round-trips to a remote pooler from a CI runner is what was actually
    // slow, not a hang. Batch it instead: owners first (de-duped by wallet,
    // since a wallet can own several teams and we don't want two concurrent
    // upserts racing on the same owner row), then team+score rows in
    // parallel batches (safe to parallelize — `rows` is already de-duped by
    // cardId, so no two batched writes ever target the same team/score row).
    const WRITE_BATCH = 15;

    const ownersByWallet = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!ownersByWallet.has(row.ownerWallet)) ownersByWallet.set(row.ownerWallet, row);
    }
    const uniqueOwners = [...ownersByWallet.values()];

    for (let i = 0; i < uniqueOwners.length; i += WRITE_BATCH) {
      const batch = uniqueOwners.slice(i, i + WRITE_BATCH);
      await Promise.all(
        batch.map((row) => {
          const profile = profiles[row.ownerWallet];
          return prisma.owner.upsert({
            where: { wallet: row.ownerWallet },
            create: {
              wallet: row.ownerWallet,
              displayName: profile?.displayName ?? row.username,
              imageUrl: profile?.imageUrl ?? null,
              equippedBadge: profile?.equippedBadge ?? null,
              ripenessTier: profile?.ripeness?.tier ?? null,
              ripenessLabel: profile?.ripeness?.label ?? null,
              ripenessCount: profile?.ripeness?.count ?? null,
            },
            update: {
              displayName: profile?.displayName ?? row.username,
              imageUrl: profile?.imageUrl ?? null,
              equippedBadge: profile?.equippedBadge ?? null,
              ripenessTier: profile?.ripeness?.tier ?? null,
              ripenessLabel: profile?.ripeness?.label ?? null,
              ripenessCount: profile?.ripeness?.count ?? null,
            },
          });
        })
      );
    }
    log(`[sync] wrote ${uniqueOwners.length} owners, writing team + score rows...`);

    let written = 0;
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const batch = rows.slice(i, i + WRITE_BATCH);
      await Promise.all(
        batch.map(async (row) => {
          const parsed = parseTeamName(row.teamName);
          if (!parsed.cardId) return;
          const cardId = parsed.cardId;
          const leaguePrefix = parsed.leaguePrefix;

          await prisma.team.upsert({
            where: { seasonSlug_cardId: { seasonSlug: season.slug, cardId } },
            create: {
              cardId,
              seasonSlug: season.slug,
              leagueId: row.leagueId,
              leagueName: leaguePrefix,
              level: row.level,
              ownerWallet: row.ownerWallet,
            },
            update: {
              leagueId: row.leagueId,
              leagueName: leaguePrefix,
              level: row.level,
              ownerWallet: row.ownerWallet,
            },
          });

          await prisma.scoreSnapshot.upsert({
            where: {
              seasonSlug_teamCardId_gameweek: { seasonSlug: season.slug, teamCardId: cardId, gameweek },
            },
            create: {
              seasonSlug: season.slug,
              teamCardId: cardId,
              gameweek,
              rank: row.rank,
              weeklyScore: row.weeklyScore,
              seasonScore: row.seasonScore,
            },
            update: {
              rank: row.rank,
              weeklyScore: row.weeklyScore,
              seasonScore: row.seasonScore,
            },
          });

          written++;
        })
      );
      log(`[sync] wrote ${Math.min(i + WRITE_BATCH, rows.length)}/${rows.length} team+score rows...`);
    }

    log(`[sync] wrote ${written} rows, finalizing sync log...`);
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), recordCount: written, ok: true },
    });

    return { gameweek, written };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

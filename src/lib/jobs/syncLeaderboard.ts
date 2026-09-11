import { prisma } from "@/lib/db";
import { getCurrentGameweek, getLeaderboard, getUserProfiles, parseTeamName } from "@/lib/sbsApi";

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
export async function runSyncLeaderboard() {
  console.log("[sync] looking up active season...");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error("No active season found — seed a Season row with isActive=true first.");
  }
  console.log(`[sync] season: ${season.slug}`);

  const log = await prisma.syncLog.create({ data: { source: "sbs-leaderboard" } });
  console.log("[sync] sync log row created, fetching current gameweek...");
  try {
    const gameweek = await getCurrentGameweek();
    console.log(`[sync] gameweek: ${gameweek}, fetching leaderboard...`);

    const [bySeason, byWeekly] = await Promise.all([
      getLeaderboard(gameweek, "SeasonScore"),
      getLeaderboard(gameweek, "WeeklyScore"),
    ]);
    console.log(`[sync] fetched ${bySeason.length} season rows, ${byWeekly.length} weekly rows`);

    const rowsByCardId = new Map<string, (typeof bySeason)[number]>();
    for (const row of [...bySeason, ...byWeekly]) {
      const { cardId } = parseTeamName(row.teamName);
      if (cardId) rowsByCardId.set(cardId, row);
    }
    const rows = [...rowsByCardId.values()];

    const wallets = [...new Set(rows.map((r) => r.ownerWallet))];
    console.log(`[sync] fetching profiles for ${wallets.length} wallets...`);
    const profiles: Record<string, Awaited<ReturnType<typeof getUserProfiles>>[string]> = {};
    const BATCH = 50;
    for (let i = 0; i < wallets.length; i += BATCH) {
      Object.assign(profiles, await getUserProfiles(wallets.slice(i, i + BATCH)));
    }
    console.log(`[sync] profiles fetched, writing ${rows.length} rows to DB...`);

    let written = 0;
    for (const row of rows) {
      const parsed = parseTeamName(row.teamName);
      if (!parsed.cardId) continue;
      const cardId = parsed.cardId;
      const leaguePrefix = parsed.leaguePrefix;
      const profile = profiles[row.ownerWallet];

      await prisma.owner.upsert({
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
    }

    console.log(`[sync] wrote ${written} rows, finalizing sync log...`);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), recordCount: written, ok: true },
    });

    return { gameweek, written };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";
import { getPodRanks, podRankByCardId, PodKey } from "@/lib/advancement";

/**
 * Serves the leaderboard from OUR database (populated by
 * scripts/sync-leaderboard.ts), not a live call to sbsfantasy.com — this is
 * what makes the page fast and keeps us from hammering SBS's API on every
 * visitor. Data is only as fresh as the last sync run.
 *
 * Query params: season (defaults to the active season), level ("all" or one
 * of KNOWN_LEVELS), limit (default 200).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const season = await resolveSeason(searchParams.get("season") ?? undefined);
  const level = searchParams.get("level") ?? "all";
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 500);

  const latestGameweek = await prisma.scoreSnapshot.findFirst({
    where: { seasonSlug: season.slug },
    orderBy: { capturedAt: "desc" },
    select: { gameweek: true },
  });
  if (!latestGameweek) {
    return NextResponse.json({ season: season.slug, gameweek: null, rows: [] });
  }

  const rows = await prisma.scoreSnapshot.findMany({
    where: {
      seasonSlug: season.slug,
      gameweek: latestGameweek.gameweek,
      team: level === "all" ? undefined : { level },
    },
    include: { team: { include: { owner: true } } },
    orderBy: { seasonScore: "desc" },
    take: limit,
  });

  // `rank` above is SBS's own field, which is GLOBAL leaderboard rank (see
  // src/lib/advancement.ts) — pod placement has to be computed separately,
  // scoped to just the pods these rows belong to.
  const podKeysSeen = new Set<string>();
  const podKeys: PodKey[] = [];
  for (const r of rows) {
    const key = `${r.team.level}::${r.team.leagueName}`;
    if (podKeysSeen.has(key)) continue;
    podKeysSeen.add(key);
    podKeys.push({ level: r.team.level, leagueName: r.team.leagueName });
  }
  const podRankByCard = podRankByCardId(await getPodRanks(season.slug, podKeys));

  return NextResponse.json({
    season: season.slug,
    gameweek: latestGameweek.gameweek,
    rows: rows.map((r) => {
      const pr = podRankByCard.get(r.teamCardId);
      return {
        cardId: r.teamCardId,
        rank: r.rank,
        weeklyScore: r.weeklyScore,
        seasonScore: r.seasonScore,
        level: r.team.level,
        leagueId: r.team.leagueId,
        leagueName: r.team.leagueName,
        status: r.team.status,
        podRank: pr?.podRank ?? null,
        podSize: pr?.podSize ?? null,
        advancing: pr?.advancing ?? false,
        owner: {
          wallet: r.team.ownerWallet,
          displayName: r.team.owner.displayName,
          imageUrl: r.team.owner.imageUrl,
        },
      };
    }),
  });
}

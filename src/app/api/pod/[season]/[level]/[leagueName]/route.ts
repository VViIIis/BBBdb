import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { REGULAR_SEASON_SNAPSHOTS } from "@/lib/advancement";

/**
 * Pod standings. See src/app/pod/[season]/[level]/[leagueName]/page.tsx for
 * why the grouping key is (season, level, leagueName) rather than the
 * Team.leagueId column.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { season: string; level: string; leagueName: string } },
) {
  const level = decodeURIComponent(params.level);
  const leagueName = decodeURIComponent(params.leagueName);

  const teams = await prisma.team.findMany({
    where: { seasonSlug: params.season, level, leagueName },
    include: { owner: true, scores: { where: REGULAR_SEASON_SNAPSHOTS, orderBy: { capturedAt: "desc" }, take: 1 } },
  });

  if (teams.length === 0) {
    return NextResponse.json(
      { error: "No pod found for this season/level/leagueName" },
      { status: 404 },
    );
  }

  const rows = teams
    .map((t) => ({
      cardId: t.cardId,
      status: t.status,
      owner: { wallet: t.ownerWallet, displayName: t.owner.displayName },
      latest: t.scores[0]
        ? {
            gameweek: t.scores[0].gameweek,
            weeklyScore: t.scores[0].weeklyScore,
            seasonScore: t.scores[0].seasonScore,
          }
        : null,
    }))
    .sort((a, b) => (b.latest?.seasonScore ?? -1) - (a.latest?.seasonScore ?? -1));

  return NextResponse.json({ season: params.season, level, leagueName, teams: rows });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Aggregates every known team for one owner wallet, across ALL seasons — the "portfolio" view. */
export async function GET(_req: NextRequest, { params }: { params: { wallet: string } }) {
  const wallet = params.wallet.toLowerCase();

  const owner = await prisma.owner.findUnique({
    where: { wallet },
    include: {
      teams: {
        include: {
          season: true,
          scores: { orderBy: { capturedAt: "desc" }, take: 1 },
        },
      },
    },
  });

  if (!owner) {
    return NextResponse.json({ error: "No teams found for this wallet" }, { status: 404 });
  }

  const teams = owner.teams.map((t) => ({
    season: t.seasonSlug,
    cardId: t.cardId,
    leagueName: t.leagueName,
    level: t.level,
    status: t.status,
    latest: t.scores[0]
      ? {
          gameweek: t.scores[0].gameweek,
          rank: t.scores[0].rank,
          weeklyScore: t.scores[0].weeklyScore,
          seasonScore: t.scores[0].seasonScore,
        }
      : null,
  }));

  const scored = teams.filter((t) => t.latest);
  const totalSeasonScore = scored.reduce((sum, t) => sum + (t.latest?.seasonScore ?? 0), 0);
  const bestTeam = scored.sort((a, b) => (b.latest?.seasonScore ?? 0) - (a.latest?.seasonScore ?? 0))[0];

  return NextResponse.json({
    owner: {
      wallet: owner.wallet,
      displayName: owner.displayName,
      imageUrl: owner.imageUrl,
      equippedBadge: owner.equippedBadge,
      ripenessLabel: owner.ripenessLabel,
    },
    summary: {
      teamCount: teams.length,
      scoredTeamCount: scored.length,
      totalSeasonScore: Math.round(totalSeasonScore * 100) / 100,
      averageSeasonScore:
        scored.length > 0 ? Math.round((totalSeasonScore / scored.length) * 100) / 100 : null,
      bestTeam: bestTeam ? { season: bestTeam.season, cardId: bestTeam.cardId } : null,
    },
    teams,
  });
}

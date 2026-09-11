import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getNftByTokenId, getRosterSlots, traitValue } from "@/lib/opensea";

/** One team's DB history plus a best-effort live OpenSea roster pull. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { season: string; cardId: string } },
) {
  const cardId = params.cardId;

  const team = await prisma.team.findUnique({
    where: { seasonSlug_cardId: { seasonSlug: params.season, cardId } },
    include: { owner: true, season: true, scores: { orderBy: { gameweek: "asc" } } },
  });

  if (!team) {
    return NextResponse.json({ error: "No team found for this season/card id" }, { status: 404 });
  }

  let roster: { slot: string; value: string }[] = [];
  let imageUrl: string | null = null;
  let openseaUrl: string | null = null;
  let rank: string | number | null = null;
  try {
    const nft = await getNftByTokenId(team.season.contract, cardId, team.season.chain);
    if (nft) {
      roster = getRosterSlots(nft);
      imageUrl = nft.image_url ?? null;
      openseaUrl = nft.opensea_url ?? null;
      rank = traitValue(nft, "RANK") ?? null;
    }
  } catch {
    // best-effort — DB data below still returns
  }

  return NextResponse.json({
    season: team.seasonSlug,
    cardId: team.cardId,
    leagueName: team.leagueName,
    level: team.level,
    status: team.status,
    owner: {
      wallet: team.ownerWallet,
      displayName: team.owner.displayName,
      imageUrl: team.owner.imageUrl,
    },
    rank,
    imageUrl,
    openseaUrl,
    roster,
    scores: team.scores.map((s) => ({
      gameweek: s.gameweek,
      rank: s.rank,
      weeklyScore: s.weeklyScore,
      seasonScore: s.seasonScore,
    })),
  });
}

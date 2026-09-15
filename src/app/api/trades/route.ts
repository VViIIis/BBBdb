import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";
import { getPodRanks, podRankByCardId, PodKey } from "@/lib/advancement";

/** Recent marketplace sales for one season, as JSON. See src/app/trades/page.tsx
 * for the full breakdowns (most-traded Team Positions, top traders) — this
 * endpoint just exposes the raw sale rows for now. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const season = await resolveSeason(searchParams.get("season") ?? undefined);
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

  if (!season.collectionSlug) {
    return NextResponse.json({ season: season.slug, sales: [], note: "no collectionSlug configured for this season" });
  }

  const sales = await prisma.sale.findMany({
    where: { seasonSlug: season.slug },
    orderBy: { occurredAt: "desc" },
    take: limit,
    include: { team: { select: { leagueName: true, level: true } } },
  });

  // Pod placement for the teams in this page of sales — see
  // src/lib/advancement.ts for why this can't just be read off SBS's own
  // `_rank` field (it's global, not per-pod).
  const podKeysSeen = new Set<string>();
  const podKeys: PodKey[] = [];
  for (const s of sales) {
    const key = `${s.team.level}::${s.team.leagueName}`;
    if (podKeysSeen.has(key)) continue;
    podKeysSeen.add(key);
    podKeys.push({ level: s.team.level, leagueName: s.team.leagueName });
  }
  const podRankByCard = podRankByCardId(await getPodRanks(season.slug, podKeys));

  return NextResponse.json({
    season: season.slug,
    sales: sales.map((s) => {
      const pr = podRankByCard.get(s.teamCardId);
      return {
        teamCardId: s.teamCardId,
        leagueName: s.team.leagueName,
        level: s.team.level,
        podRank: pr?.podRank ?? null,
        podSize: pr?.podSize ?? null,
        advancing: pr?.advancing ?? false,
        from: s.fromWallet,
        to: s.toWallet,
        priceEth: s.priceEth,
        paymentSymbol: s.paymentSymbol,
        marketplace: s.marketplace,
        occurredAt: s.occurredAt,
      };
    }),
  });
}

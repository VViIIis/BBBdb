import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";

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

  return NextResponse.json({
    season: season.slug,
    sales: sales.map((s) => ({
      teamCardId: s.teamCardId,
      leagueName: s.team.leagueName,
      level: s.team.level,
      from: s.fromWallet,
      to: s.toWallet,
      priceEth: s.priceEth,
      paymentSymbol: s.paymentSymbol,
      marketplace: s.marketplace,
      occurredAt: s.occurredAt,
    })),
  });
}

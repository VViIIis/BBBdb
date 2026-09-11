import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";

/** Owners ranked by number of drafted teams, for one season. See src/app/owners/page.tsx. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const season = await resolveSeason(searchParams.get("season") ?? undefined);
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

  // Grouping by `level` too so we can break out each tier — Pro alongside
  // the specialty tiers (Jackpot / Hall of Fame / JackHOF) — see the same
  // comment in src/app/owners/page.tsx.
  const grouped = await prisma.team.groupBy({
    by: ["ownerWallet", "status", "level"],
    where: { seasonSlug: season.slug },
    _count: { _all: true },
  });

  const byWallet = new Map<
    string,
    { drafted: number; draftPasses: number; pro: number; jackpot: number; hof: number; jackHof: number }
  >();
  for (const g of grouped) {
    const entry =
      byWallet.get(g.ownerWallet) ??
      { drafted: 0, draftPasses: 0, pro: 0, jackpot: 0, hof: 0, jackHof: 0 };
    if (g.status === "draft_pass") {
      entry.draftPasses += g._count._all;
    } else {
      entry.drafted += g._count._all;
      if (g.level === "Pro") entry.pro += g._count._all;
      else if (g.level === "Jackpot") entry.jackpot += g._count._all;
      else if (g.level === "Hall of Fame") entry.hof += g._count._all;
      else if (g.level === "JackHOF") entry.jackHof += g._count._all;
    }
    byWallet.set(g.ownerWallet, entry);
  }

  // Sorted by overall drafted teams (every level combined); `total` is the
  // literal sum of the tier columns below so it always tallies against them.
  const ranked = [...byWallet.entries()]
    .map(([wallet, counts]) => ({ wallet, ...counts }))
    .filter((r) => r.drafted > 0)
    .sort((a, b) => b.drafted - a.drafted)
    .slice(0, limit);

  const owners = await prisma.owner.findMany({
    where: { wallet: { in: ranked.map((r) => r.wallet) } },
  });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));

  return NextResponse.json({
    season: season.slug,
    owners: ranked.map((r) => ({
      wallet: r.wallet,
      displayName: ownerByWallet.get(r.wallet)?.displayName ?? null,
      pro: r.pro,
      jackpot: r.jackpot,
      hallOfFame: r.hof,
      jackHof: r.jackHof,
      draftPassesHeld: r.draftPasses,
      total: r.pro + r.jackpot + r.hof + r.jackHof + r.draftPasses,
    })),
  });
}

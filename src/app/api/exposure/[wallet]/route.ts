import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { positionOf } from "@/lib/opensea";
import { resolveSeason } from "@/lib/seasons";

/**
 * Team-Position exposure for one owner, for one season. See
 * src/app/exposure/page.tsx for the "why team-positions, not players" note
 * and the same counting logic (kept in sync with this route by hand — this
 * is a small enough calculation that a shared helper felt like more
 * indirection than it's worth, but if the two drift, this route is the
 * source of truth for the numbers).
 */
export async function GET(req: NextRequest, { params }: { params: { wallet: string } }) {
  const wallet = params.wallet.toLowerCase();
  const { searchParams } = new URL(req.url);
  const season = await resolveSeason(searchParams.get("season") ?? undefined);
  const positionFilter = searchParams.get("position");

  const owner = await prisma.owner.findUnique({ where: { wallet } });
  if (!owner) {
    return NextResponse.json({ error: "No owner found for this wallet" }, { status: 404 });
  }

  const teams = await prisma.team.findMany({
    where: { ownerWallet: wallet, seasonSlug: season.slug, status: { not: "draft_pass" } },
    include: { rosterSlots: true },
  });

  const counts = new Map<string, { count: number; position: string }>();
  let anyRosterData = false;
  for (const t of teams) {
    if (t.rosterSlots.length > 0) anyRosterData = true;
    const seenThisTeam = new Set<string>();
    for (const rs of t.rosterSlots) {
      if (seenThisTeam.has(rs.value)) continue;
      seenThisTeam.add(rs.value);
      const entry = counts.get(rs.value) ?? { count: 0, position: positionOf(rs.slot) };
      entry.count += 1;
      counts.set(rs.value, entry);
    }
  }

  const totalDrafted = teams.length;
  const exposure = [...counts.entries()]
    .map(([value, c]) => ({
      value,
      position: c.position,
      teams: c.count,
      pct: totalDrafted > 0 ? Math.round((c.count / totalDrafted) * 1000) / 10 : 0,
    }))
    .filter((r) => !positionFilter || r.position === positionFilter)
    .sort((a, b) => b.teams - a.teams || a.value.localeCompare(b.value));

  return NextResponse.json({
    season: season.slug,
    owner: { wallet: owner.wallet, displayName: owner.displayName },
    totalDrafted,
    rosterDataMissing: totalDrafted > 0 && !anyRosterData,
    exposure,
  });
}

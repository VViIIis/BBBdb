import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";
import { getPodRanks, rollupByOwner } from "@/lib/advancement";

/**
 * Owners ranked by advancement rate (teams currently in the top 2 of their
 * pod / teams that have a score so far), for one season. See
 * src/app/advancement/page.tsx. This is the one place in the app that
 * scans EVERY pod in a season (getPodRanks with no `pods` filter) — every
 * other page badges a handful of already-known teams instead.
 *
 * `minTeams` mirrors the page's own min-drafts filter (a raw rate sort lets
 * a 1-draft 100% owner outrank a real track record) but defaults to 0
 * (unfiltered) here rather than the page's default of 10 — an API caller
 * asked for "advancement", not "advancement, pre-filtered the way the page
 * happens to filter it," so they opt in with ?minTeams= instead.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const season = await resolveSeason(searchParams.get("season") ?? undefined);
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 500);
  const minTeamsParam = Number(searchParams.get("minTeams") ?? 0);
  const minTeams = Number.isFinite(minTeamsParam) && minTeamsParam > 0 ? Math.floor(minTeamsParam) : 0;

  const podRanks = await getPodRanks(season.slug);
  const ranked = rollupByOwner(podRanks)
    .filter((r) => r.scoredTeams > 0 && r.scoredTeams >= minTeams)
    .sort(
      (a, b) =>
        (b.rate ?? -1) - (a.rate ?? -1) ||
        b.advancing - a.advancing ||
        b.scoredTeams - a.scoredTeams ||
        a.ownerWallet.localeCompare(b.ownerWallet),
    )
    .slice(0, limit);

  const owners = await prisma.owner.findMany({
    where: { wallet: { in: ranked.map((r) => r.ownerWallet) } },
  });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));

  return NextResponse.json({
    season: season.slug,
    owners: ranked.map((r) => ({
      wallet: r.ownerWallet,
      displayName: ownerByWallet.get(r.ownerWallet)?.displayName ?? null,
      advancing: r.advancing,
      scoredTeams: r.scoredTeams,
      totalTeams: r.totalTeams,
      rate: r.rate,
    })),
  });
}

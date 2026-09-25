import Link from "next/link";
import OwnerAvatar from "@/components/OwnerAvatar";
import { prisma } from "@/lib/db";
import SeasonTabs from "@/components/SeasonTabs";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";

export const dynamic = "force-dynamic";

const LIMIT = 100;

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function OwnersLeaderboardPage({
  searchParams,
}: {
  searchParams: { season?: string };
}) {
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  // Unlike most best-ball sites (Underdog caps entries at 150/user), SBS has
  // no per-wallet draft cap, so "most teams drafted" is a real leaderboard
  // here, not a trivia stat. We count DRAFTED teams (status != "draft_pass")
  // separately from unrevealed Draft Passes a wallet is just holding, since
  // those aren't teams yet. Scoped to one season at a time — combining
  // seasons would make "most teams" mostly reflect who's been playing
  // longest rather than who went hardest in a given season.
  //
  // Also grouping by `level` so we can break out each tier — Pro (the
  // standard draft) alongside the specialty tiers (Jackpot / Hall of Fame /
  // JackHOF) — as its own column, instead of one flat drafted-teams total.
  // `drafted` (all levels combined, incl. Founder) is still tracked
  // internally for sorting and for the Total column's math, even though
  // it's no longer shown as its own column.
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

  // Sorted by overall drafted teams (every level combined, incl. any rare
  // Founder-tier teams that don't get their own column) — the Total column
  // itself is the literal sum of the columns actually shown, so it always
  // tallies even if `drafted` (used only for ranking here) is technically a
  // hair higher in the rare case an owner holds a Founder-tier team.
  const ranked = [...byWallet.entries()]
    .map(([wallet, counts]) => ({ wallet, ...counts }))
    .filter((r) => r.drafted > 0)
    .sort((a, b) => b.drafted - a.drafted)
    .slice(0, LIMIT);

  const owners = await prisma.owner.findMany({
    where: { wallet: { in: ranked.map((r) => r.wallet) } },
  });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Most teams drafted</h1>
      <p className="mb-4 text-sm text-zinc-400">
        {season.name} · SBS has no per-wallet draft cap (unlike Underdog&rsquo;s 150-entry limit),
        so this ranks every owner by how many teams they&rsquo;ve actually drafted — top {LIMIT}{" "}
        shown.
      </p>

      <div className="mb-4">
        <SeasonTabs seasons={seasons} current={season.slug} basePath="/owners" />
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full sm:min-w-[720px] text-left text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-2 py-2 sm:px-3">#</th>
              <th className="px-2 py-2 sm:px-3">Owner</th>
              <th className="px-2 py-2 sm:px-3 text-right">Pro</th>
              <th className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right">Jackpot</th>
              <th className="px-2 py-2 sm:px-3 text-right">HOF</th>
              <th className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right">JackHOF</th>
              <th className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right">Draft passes held</th>
              <th className="px-2 py-2 sm:px-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const owner = ownerByWallet.get(r.wallet);
              return (
                <tr key={r.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3 text-zinc-400">{i + 1}</td>
                  <td className="px-2 py-2 sm:px-3">
                    <Link href={`/owner/${r.wallet}`} className="flex items-center gap-2 hover:text-banana-400">
                      <OwnerAvatar imageUrl={owner?.imageUrl} />
                      <span>{owner?.displayName ?? shortWallet(r.wallet)}</span>
                    </Link>
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">{r.pro || "—"}</td>
                  <td className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.jackpot || "—"}</td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.hof || "—"}</td>
                  <td className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.jackHof || "—"}</td>
                  <td className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.draftPasses}</td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">
                    {r.pro + r.jackpot + r.hof + r.jackHof + r.draftPasses}
                  </td>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-zinc-500">
                  No teams synced yet for {season.name}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

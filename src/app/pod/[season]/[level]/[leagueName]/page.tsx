import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { REGULAR_SEASON_SNAPSHOTS } from "@/lib/advancement";

export const dynamic = "force-dynamic";

// Pod membership: teams are grouped by (season, level, leagueName) — e.g.
// "bbb4" + "Pro" + "BBB #687". We group on leagueName rather than the
// `leagueId` column on purpose. sync-leaderboard.ts (SBS's own API) writes
// leagueId as SBS's internal slug (e.g. "2026-fast-draft-606"), while
// sync-collection.ts (OpenSea) writes a synthetic id derived from the
// "League #" trait (e.g. "sbs-league-687") — the two sources don't agree on
// that field, so whoever synced a given row last wins, and grouping by it
// would silently split a real pod across two "pods". `leagueName` (e.g.
// "BBB #687") is written identically by both sources — it's the display
// label SBS itself puts in team names — so it's the reliable grouping key.
// `level` has to be part of the key too: pod numbering resets per level, so
// e.g. "BBB #99" exists as a completely different pod under Hall of Fame
// and under JackHOF. `season` has to be part of it for the same reason
// once a second season exists — BBB III and BBB IV both have a "BBB #1".
function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function PodPage({
  params,
}: {
  params: { season: string; level: string; leagueName: string };
}) {
  const level = decodeURIComponent(params.level);
  const leagueName = decodeURIComponent(params.leagueName);

  const teams = await prisma.team.findMany({
    where: { seasonSlug: params.season, level, leagueName },
    include: {
      owner: true,
      // Rank the pod on weeks 1-14 only; see REGULAR_SEASON_SNAPSHOTS.
      scores: { where: REGULAR_SEASON_SNAPSHOTS, orderBy: { capturedAt: "desc" }, take: 1 },
    },
  });

  if (teams.length === 0) notFound();

  const rows = teams
    .map((t) => ({ ...t, latest: t.scores[0] ?? null }))
    .sort((a, b) => (b.latest?.seasonScore ?? -1) - (a.latest?.seasonScore ?? -1));

  const anyScored = rows.some((r) => r.latest);

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">
        {leagueName} <span className="text-zinc-500">pod</span>
      </h1>
      <p className="mb-6 text-sm text-zinc-400">
        {level} · {rows.length} team{rows.length === 1 ? "" : "s"}. Per SBS rules, weeks 1–14 score
        cumulatively within a pod and the top 2 advance.
      </p>

      <div className="overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full sm:min-w-[560px] text-left text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-2 py-2 sm:px-3">#</th>
              <th className="px-2 py-2 sm:px-3">Team</th>
              <th className="px-2 py-2 sm:px-3">Owner</th>
              <th className="px-2 py-2 sm:px-3 text-right">Weekly</th>
              <th className="px-2 py-2 sm:px-3 text-right">Season</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const advancing = i < 2 && !!t.latest;
              return (
                <tr
                  key={t.cardId}
                  className={`border-t border-ink-600 ${advancing ? "bg-banana-400/10" : ""}`}
                >
                  <td className="px-2 py-2 sm:px-3 text-zinc-400">
                    {i + 1}
                    {advancing && (
                      <span className="ml-1 text-xs text-banana-400">↑<span className="hidden sm:inline"> advancing</span></span>
                    )}
                  </td>
                  <td className="px-2 py-2 sm:px-3">
                    <Link href={`/team/${t.seasonSlug}/${t.cardId}`} className="hover:text-banana-400">
                      #{t.cardId}
                    </Link>
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-zinc-400">
                    <Link href={`/owner/${t.ownerWallet}`} className="hover:text-banana-400">
                      {t.owner.displayName ?? shortWallet(t.ownerWallet)}
                    </Link>
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono">
                    {t.latest ? t.latest.weeklyScore.toFixed(2) : "—"}
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">
                    {t.latest ? t.latest.seasonScore.toFixed(2) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!anyScored && (
        <p className="mt-3 text-xs text-zinc-500">
          None of these teams have a score snapshot yet, so standings can&rsquo;t be ranked yet —
          check back after the next leaderboard sync.
        </p>
      )}
    </main>
  );
}

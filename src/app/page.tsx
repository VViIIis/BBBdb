import Link from "next/link";
import { prisma } from "@/lib/db";
import LevelTabs from "@/components/LevelTabs";
import SeasonTabs from "@/components/SeasonTabs";
import { KNOWN_LEVELS } from "@/lib/sbsApi";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";

export const dynamic = "force-dynamic"; // always read latest synced data, never cache stale scores

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// Sortable columns. `rank` defaults ascending (1 = best), Weekly/Season
// default descending (highest score first) — each column remembers its own
// natural direction so clicking a new column doesn't require a second click
// to get a sensible order.
const SORT_COLUMNS = {
  rank: { label: "Rank", defaultDir: "asc" as const },
  weekly: { label: "Weekly", defaultDir: "desc" as const },
  season: { label: "Season", defaultDir: "desc" as const },
};
type SortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string | undefined): v is SortKey {
  return !!v && v in SORT_COLUMNS;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: { level?: string; season?: string; sort?: string; dir?: string };
}) {
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  const level = searchParams.level && (KNOWN_LEVELS as readonly string[]).includes(searchParams.level)
    ? searchParams.level
    : "all";

  const sortKey: SortKey = isSortKey(searchParams.sort) ? searchParams.sort : "season";
  const dir: "asc" | "desc" = searchParams.dir === "asc" || searchParams.dir === "desc"
    ? searchParams.dir
    : SORT_COLUMNS[sortKey].defaultDir;

  // Query-string builder for a clickable column header: clicking the
  // already-active column flips its direction, clicking a different column
  // switches to that column's own default direction. Preserves level/season
  // filters. Same link-based pattern as SeasonTabs/LevelTabs — no client JS.
  function sortHref(column: SortKey) {
    const params = new URLSearchParams();
    if (level !== "all") params.set("level", level);
    if (searchParams.season) params.set("season", searchParams.season);
    params.set("sort", column);
    params.set("dir", column === sortKey && dir === SORT_COLUMNS[column].defaultDir
      ? (dir === "asc" ? "desc" : "asc")
      : SORT_COLUMNS[column].defaultDir);
    return `/?${params.toString()}`;
  }

  function sortIndicator(column: SortKey) {
    if (column !== sortKey) return null;
    return <span className="ml-1 text-banana-400">{dir === "asc" ? "▲" : "▼"}</span>;
  }

  // "last synced" is shown from SyncLog rather than ScoreSnapshot.capturedAt:
  // SyncLog gets a fresh row every run (see syncLeaderboard.ts), so it can't
  // drift from what GitHub Actions' run history shows the way capturedAt
  // could when a sync just re-upserts scores onto an already-existing
  // gameweek row.
  const [latest, lastSync] = await Promise.all([
    prisma.scoreSnapshot.findFirst({
      where: { seasonSlug: season.slug },
      orderBy: { capturedAt: "desc" },
      select: { gameweek: true, capturedAt: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: "sbs-leaderboard", ok: true },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
  ]);
  const lastSyncedAt = lastSync?.finishedAt ?? latest?.capturedAt ?? null;

  const orderBy =
    sortKey === "rank"
      ? { rank: { sort: dir, nulls: "last" as const } }
      : sortKey === "weekly"
        ? { weeklyScore: dir }
        : { seasonScore: dir };

  const rows = latest
    ? await prisma.scoreSnapshot.findMany({
        where: {
          seasonSlug: season.slug,
          gameweek: latest.gameweek,
          team: level === "all" ? undefined : { level },
        },
        include: { team: { include: { owner: true } } },
        orderBy,
        take: 200,
      })
    : [];

  return (
    <main>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-bold">Leaderboard</h1>
          <p className="text-sm text-zinc-400">
            {season.name}
            {latest
              ? ` · gameweek ${latest.gameweek} · last synced ${lastSyncedAt ? lastSyncedAt.toLocaleString() : "unknown"}`
              : season.isActive
                ? " · no data yet — run `npm run sync:leaderboard` to pull the first snapshot."
                : " · this season isn't live-scored — see the team pages for final results."}
          </p>
        </div>
        <form action="/search" method="GET" className="flex gap-2 sm:w-64">
          <input
            type="text"
            name="q"
            placeholder="Find a team by username..."
            className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-banana-400 px-3 py-2 text-sm font-semibold text-ink-900"
          >
            Search
          </button>
        </form>
      </div>

      <div className="mb-3">
        <SeasonTabs seasons={seasons} current={season.slug} basePath="/" />
      </div>

      <LevelTabs current={level} />

      <div className="mt-4 overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-3 py-2">
                <Link href={sortHref("rank")} className="hover:text-banana-400">
                  Rank{sortIndicator("rank")}
                </Link>
              </th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Level</th>
              <th className="px-3 py-2 text-right">
                <Link href={sortHref("weekly")} className="hover:text-banana-400">
                  Weekly{sortIndicator("weekly")}
                </Link>
              </th>
              <th className="px-3 py-2 text-right">
                <Link href={sortHref("season")} className="hover:text-banana-400">
                  Season{sortIndicator("season")}
                </Link>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.teamCardId} className="border-t border-ink-600 hover:bg-ink-800/60">
                <td className="px-3 py-2 text-zinc-400">{r.rank ?? "—"}</td>
                <td className="px-3 py-2">
                  <Link href={`/owner/${r.team.ownerWallet}`} className="hover:text-banana-400">
                    {r.team.owner.displayName ?? shortWallet(r.team.ownerWallet)}
                  </Link>
                </td>
                <td className="px-3 py-2 text-zinc-400">
                  <Link href={`/team/${season.slug}/${r.teamCardId}`} className="hover:text-banana-400">
                    {r.team.leagueName} · #{r.teamCardId}
                  </Link>{" "}
                  <Link
                    href={`/pod/${season.slug}/${encodeURIComponent(r.team.level)}/${encodeURIComponent(r.team.leagueName)}`}
                    className="text-xs text-zinc-500 hover:text-banana-400"
                  >
                    (pod)
                  </Link>
                </td>
                <td className="px-3 py-2 text-zinc-400">{r.team.level}</td>
                <td className="px-3 py-2 text-right font-mono">{r.weeklyScore.toFixed(2)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">
                  {r.seasonScore.toFixed(2)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-zinc-500">
                  No teams to show yet for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

import Link from "next/link";
import SlotTabs, { isStatsSlot, StatsSlot } from "@/components/SlotTabs";
import { getSlotLeaders, getStatsSeasons } from "@/lib/statsRollup";

export const dynamic = "force-dynamic";

const SORT_COLUMNS = {
  total: { label: "Total pts", defaultDir: "desc" as const },
  avg: { label: "Avg/gm", defaultDir: "desc" as const },
  games: { label: "Games", defaultDir: "desc" as const },
};
type SortKey = keyof typeof SORT_COLUMNS;
function isSortKey(v: string | undefined): v is SortKey {
  return !!v && v in SORT_COLUMNS;
}

// Every column in SORT_COLUMNS currently defaults to "desc" — TS narrows a
// direct `dir === "asc" ? "desc" : "asc"` inline to a literal-type
// no-overlap error once it sees that, same as src/app/advancement/page.tsx.
// This indirection (an explicit "asc" | "desc" parameter) keeps the flip
// generic rather than because there's a real runtime concern.
function flipDir(d: "asc" | "desc"): "asc" | "desc" {
  return d === "asc" ? "desc" : "asc";
}

function slotLabel(slot: StatsSlot) {
  return slot === "DST" ? "D/ST" : slot;
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: { season?: string; slot?: string; sort?: string; dir?: string };
}) {
  const seasons = await getStatsSeasons();
  const requestedSeason = Number(searchParams.season);
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];

  const slot: StatsSlot = isStatsSlot(searchParams.slot) ? searchParams.slot : "QB";
  const sortKey: SortKey = isSortKey(searchParams.sort) ? searchParams.sort : "total";
  const dir: "asc" | "desc" =
    searchParams.dir === "asc" || searchParams.dir === "desc" ? searchParams.dir : SORT_COLUMNS[sortKey].defaultDir;

  function sortHref(column: SortKey) {
    const params = new URLSearchParams();
    params.set("season", String(season));
    params.set("slot", slot);
    params.set("sort", column);
    params.set(
      "dir",
      column === sortKey && dir === SORT_COLUMNS[column].defaultDir ? flipDir(dir) : SORT_COLUMNS[column].defaultDir,
    );
    return `/stats?${params.toString()}`;
  }

  function sortArrow(column: SortKey) {
    if (column !== sortKey) return null;
    return <span className="text-banana-400"> {dir === "asc" ? "↑" : "↓"}</span>;
  }

  if (!season) {
    return (
      <main>
        <h1 className="mb-1 text-2xl font-bold">Stats</h1>
        <p className="text-sm text-zinc-400">
          No games synced yet — visit <Link href="/scores" className="underline hover:text-banana-400">Scores</Link>{" "}
          once <code className="text-zinc-300">npm run sync:scores</code> has run.
        </p>
      </main>
    );
  }

  const leadersRaw = await getSlotLeaders(season, slot);
  const leaders = [...leadersRaw].sort((a, b) => {
    const av = sortKey === "total" ? a.totalPoints : sortKey === "avg" ? a.avgPoints : a.games;
    const bv = sortKey === "total" ? b.totalPoints : sortKey === "avg" ? b.avgPoints : b.games;
    return dir === "asc" ? av - bv || a.team.localeCompare(b.team) : bv - av || a.team.localeCompare(b.team);
  });

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Stats</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Season-long SBS &ldquo;Team Position&rdquo; leaderboards, rolled up from every synced final box score on{" "}
        <Link href="/scores" className="underline hover:text-banana-400">
          Scores
        </Link>
        . Ranks which real NFL team has been the best draft at each slot this season — not an individual player, since
        the player filling a slot can change week to week. Unofficial fan project, not affiliated with SBS Fantasy.
      </p>

      {seasons.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {seasons.map((s) => (
            <Link
              key={s}
              href={`/stats?season=${s}&slot=${slot}`}
              className={`rounded-full px-3 py-1 text-sm ${
                s === season ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      )}

      <div className="mb-6">
        <SlotTabs season={season} current={slot} />
      </div>

      {leaders.length === 0 ? (
        <p className="text-sm text-zinc-500">No final games with a {slotLabel(slot)} slot yet this season.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-600">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600 bg-ink-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Team</th>
                <th className="cursor-pointer px-3 py-2 hover:text-banana-400">
                  <Link href={sortHref("total")}>Total pts{sortArrow("total")}</Link>
                </th>
                <th className="cursor-pointer px-3 py-2 hover:text-banana-400">
                  <Link href={sortHref("avg")}>Avg/gm{sortArrow("avg")}</Link>
                </th>
                <th className="cursor-pointer px-3 py-2 hover:text-banana-400">
                  <Link href={sortHref("games")}>Games{sortArrow("games")}</Link>
                </th>
                <th className="px-3 py-2">Best game</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((row, i) => (
                <tr key={row.team} className="border-b border-ink-700 last:border-0 hover:bg-ink-800">
                  <td className="px-3 py-2 text-zinc-500">{i + 1}</td>
                  <td className="px-3 py-2 font-semibold text-zinc-100">{row.team}</td>
                  <td className="px-3 py-2 font-bold tabular-nums text-banana-400">{row.totalPoints.toFixed(2)}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">{row.avgPoints.toFixed(2)}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">{row.games}</td>
                  <td className="px-3 py-2 text-zinc-400">
                    {row.bestGame ? (
                      <Link
                        href={`/scores?season=${season}&week=${row.bestGame.week}`}
                        className="hover:text-banana-400 hover:underline"
                      >
                        {row.bestGame.playerName ?? "—"} · {row.bestGame.points.toFixed(2)} (Wk {row.bestGame.week} vs{" "}
                        {row.bestGame.opponent})
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

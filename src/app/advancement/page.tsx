import Link from "next/link";
import OwnerAvatar from "@/components/OwnerAvatar";
import { prisma } from "@/lib/db";
import SeasonTabs from "@/components/SeasonTabs";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";
import { getPodRanks, rollupByOwner, OwnerAdvancement } from "@/lib/advancement";

export const dynamic = "force-dynamic";

const LIMIT = 200;

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// Sortable columns, same clickable-header pattern as the main leaderboard
// (src/app/page.tsx) — each remembers its own natural (most-impressive-
// first) direction.
const SORT_COLUMNS = {
  rate: { label: "Rate", defaultDir: "desc" as const },
  advancing: { label: "Advancing", defaultDir: "desc" as const },
  scoredTeams: { label: "Scored teams", defaultDir: "desc" as const },
};
type SortKey = keyof typeof SORT_COLUMNS;
function isSortKey(v: string | undefined): v is SortKey {
  return !!v && v in SORT_COLUMNS;
}

// Every column in SORT_COLUMNS currently defaults to "desc" — TS narrows a
// direct `dir === "asc" ? "desc" : "asc"` inline to a literal-type
// no-overlap error once it sees that, so this indirection (an explicit
// "asc" | "desc" parameter) exists purely to keep the flip generic rather
// than because there's a real runtime concern.
function flipDir(d: "asc" | "desc"): "asc" | "desc" {
  return d === "asc" ? "desc" : "asc";
}

// Sorting by raw rate alone lets a wallet with one lucky draft (1/1, 100%)
// sit above owners with a real track record — Jack's own complaint after
// shipping this page. Rather than change what "Rate" sorts by, default to
// filtering the table down to owners with a real sample size first; "All"
// is still one click away for anyone who wants the unfiltered view. 10 is
// Jack's own example threshold ("min 10 drafts").
const MIN_TEAMS_OPTIONS = [1, 5, 10, 20, 50] as const;
const DEFAULT_MIN_TEAMS = 10;

function parseMinTeams(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MIN_TEAMS;
}

export default async function AdvancementPage({
  searchParams,
}: {
  searchParams: { season?: string; sort?: string; dir?: string; minTeams?: string };
}) {
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  const sortKey: SortKey = isSortKey(searchParams.sort) ? searchParams.sort : "rate";
  const dir: "asc" | "desc" =
    searchParams.dir === "asc" || searchParams.dir === "desc"
      ? searchParams.dir
      : SORT_COLUMNS[sortKey].defaultDir;
  const minTeams = searchParams.minTeams === "0" ? 0 : parseMinTeams(searchParams.minTeams);

  function sortHref(column: SortKey) {
    const params = new URLSearchParams();
    params.set("season", season.slug);
    params.set("sort", column);
    const defaultDir = SORT_COLUMNS[column].defaultDir;
    params.set(
      "dir",
      column === sortKey && dir === defaultDir ? flipDir(defaultDir) : defaultDir,
    );
    if (minTeams !== DEFAULT_MIN_TEAMS) params.set("minTeams", String(minTeams));
    return `/advancement?${params.toString()}`;
  }
  function sortIndicator(column: SortKey) {
    if (column !== sortKey) return null;
    return <span className="ml-1 text-banana-400">{dir === "asc" ? "▲" : "▼"}</span>;
  }
  function minTeamsHref(n: number) {
    const params = new URLSearchParams();
    params.set("season", season.slug);
    params.set("sort", sortKey);
    params.set("dir", dir);
    if (n !== DEFAULT_MIN_TEAMS) params.set("minTeams", String(n));
    return `/advancement?${params.toString()}`;
  }

  // Only "sbs-standings-full" (syncStandings.ts) walks every pod — the
  // lighter "sbs-leaderboard" sync only ever sees the global top-500, which
  // would leave most pods missing 8 of their 10 teams. That's the sync run
  // this page's accuracy actually depends on, so show ITS freshness, not
  // whichever of the two sources ran most recently (main leaderboard's
  // "last synced" line intentionally does the opposite, for a different
  // reason — see that page's comment).
  const lastFullSync = await prisma.syncLog.findFirst({
    where: { source: "sbs-standings-full", ok: true },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });

  // Whole-season scan — every pod, not just a handful being shown on some
  // other page. This is the one place in the app that does this; see
  // getPodRanks()'s own comment.
  const podRanks = await getPodRanks(season.slug);
  const rankedAll: OwnerAdvancement[] = rollupByOwner(podRanks).filter(
    (r) => r.scoredTeams > 0 && r.scoredTeams >= minTeams,
  );
  const ranked = [...rankedAll]
    .sort((a, b) => {
      const av = sortKey === "rate" ? a.rate ?? -1 : a[sortKey];
      const bv = sortKey === "rate" ? b.rate ?? -1 : b[sortKey];
      return dir === "asc"
        ? av - bv || a.ownerWallet.localeCompare(b.ownerWallet)
        : bv - av || a.ownerWallet.localeCompare(b.ownerWallet);
    })
    .slice(0, LIMIT);

  const owners = await prisma.owner.findMany({
    where: { wallet: { in: ranked.map((r) => r.ownerWallet) } },
  });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Advancement rate</h1>
      <p className="mb-4 text-sm text-zinc-400">
        {season.name}
        {lastFullSync
          ? ` · last full standings sync ${lastFullSync.finishedAt!.toLocaleString()}`
          : " · no full standings sync yet — run `npm run sync:standings`"}
        {" — "}
        per SBS&rsquo;s rules, every pod is 10 teams and the top 2 by season score advance out of
        Weeks 1&ndash;14, the same way across every level. Rate = advancing teams ÷ teams that have
        a score so far (a team with no score yet doesn&rsquo;t count against you).
      </p>

      <div className="mb-3">
        <SeasonTabs
          seasons={seasons}
          current={season.slug}
          basePath="/advancement"
          extraParams={{
            sort: sortKey,
            dir,
            minTeams: minTeams !== DEFAULT_MIN_TEAMS ? String(minTeams) : undefined,
          }}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-400">Min drafts:</span>
        {MIN_TEAMS_OPTIONS.map((n) => {
          const active = n === minTeams;
          return (
            <Link
              key={n}
              href={minTeamsHref(n)}
              className={`rounded-full px-3 py-1 text-sm ${
                active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
              }`}
            >
              {n}+
            </Link>
          );
        })}
        <Link
          href={minTeamsHref(0)}
          className={`rounded-full px-3 py-1 text-sm ${
            minTeams === 0 ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
          }`}
        >
          All
        </Link>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full sm:min-w-[560px] text-left text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-2 py-2 sm:px-3">#</th>
              <th className="px-2 py-2 sm:px-3">Owner</th>
              <th className="px-2 py-2 sm:px-3 text-right">
                <Link href={sortHref("advancing")} className="hover:text-banana-400">
                  Advancing{sortIndicator("advancing")}
                </Link>
              </th>
              <th className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right">
                <Link href={sortHref("scoredTeams")} className="hover:text-banana-400">
                  Scored teams{sortIndicator("scoredTeams")}
                </Link>
              </th>
              <th className="px-2 py-2 sm:px-3 text-right">
                <Link href={sortHref("rate")} className="hover:text-banana-400">
                  Rate{sortIndicator("rate")}
                </Link>
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const owner = ownerByWallet.get(r.ownerWallet);
              return (
                <tr key={r.ownerWallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3 text-zinc-400">{i + 1}</td>
                  <td className="px-2 py-2 sm:px-3">
                    <Link href={`/owner/${r.ownerWallet}`} className="flex items-center gap-2 hover:text-banana-400">
                      <OwnerAvatar imageUrl={owner?.imageUrl} />
                      <span>{owner?.displayName ?? shortWallet(r.ownerWallet)}</span>
                    </Link>
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono">{r.advancing}</td>
                  <td className="hidden sm:table-cell px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">
                    {r.scoredTeams}
                    {r.totalTeams > r.scoredTeams && (
                      <span className="text-xs text-zinc-500"> ({r.totalTeams - r.scoredTeams} unscored)</span>
                    )}
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">
                    {r.advancing}/{r.scoredTeams} ({((r.rate ?? 0) * 100).toFixed(0)}%)
                  </td>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-zinc-500">
                  {minTeams > 0
                    ? `No owners with ${minTeams}+ scored teams yet for ${season.name}.`
                    : `No scored teams yet for ${season.name}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

import Link from "next/link";
import OwnerAvatar from "@/components/OwnerAvatar";
import { prisma } from "@/lib/db";
import LevelTabs from "@/components/LevelTabs";
import SeasonTabs from "@/components/SeasonTabs";
import { KNOWN_LEVELS } from "@/lib/sbsApi";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";
import { getPodRanks, podRankByCardId, ordinal, PodKey } from "@/lib/advancement";

export const dynamic = "force-dynamic"; // always read latest synced data, never cache stale scores

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// "2026REG-03" -> 3. Anything else (e.g. an imported "bbb3-final"
// snapshot, see schema.prisma) has no week number -> null.
function weekNumberOf(gameweek: string): number | null {
  const m = gameweek.match(/^\d{4}REG-(\d+)$/);
  return m ? Number(m[1]) : null;
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

// SBS's own posted weekly payout table (confirmed live on sbsfantasy.com/teams
// 2026-09-25: top 5 by weekly score get a colored badge + this exact $
// figure), active weeks 1-14 only — week 15+ is Hall of Fame/finals
// territory with its own separate payout structure, not this one. Index 0 =
// 1st place.
const WEEKLY_PRIZES = [250, 100, 50, 35, 20];
// Graduated badge intensity so 1st stands out most and 5th least, without
// introducing five arbitrary new colors into a palette that's otherwise just
// banana-400 + ink/zinc everywhere else on the site.
const WEEKLY_PRIZE_BADGE_CLASS = [
  "bg-banana-400 text-ink-900",
  "bg-banana-400/85 text-ink-900",
  "bg-banana-400/70 text-ink-900",
  "bg-banana-400/55 text-ink-900",
  "bg-banana-400/40 text-ink-900",
];

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: { level?: string; season?: string; sort?: string; dir?: string; week?: string };
}) {
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  const level = searchParams.level && (KNOWN_LEVELS as readonly string[]).includes(searchParams.level)
    ? searchParams.level
    : "all";

  // Defaults to Weekly rather than Season: with SBS's weekly top-5 cash
  // prizes now live (see WEEKLY_PRIZES below), Weekly score is the number
  // that actually matters day-to-day, so it's what the leaderboard should
  // open on rather than requiring a click.
  const sortKey: SortKey = isSortKey(searchParams.sort) ? searchParams.sort : "weekly";
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
    if (searchParams.week) params.set("week", searchParams.week);
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
  // gameweek row. Two sources write scores now (sbs-leaderboard: light,
  // frequent, top-500-only; sbs-standings-full: heavy, less frequent, every
  // team — see syncStandings.ts) — whichever ran most recently is what's
  // actually reflected in the DB, so take the max of the two.
  const [latest, lastSync, gameweekGroups] = await Promise.all([
    prisma.scoreSnapshot.findFirst({
      where: { seasonSlug: season.slug },
      orderBy: { capturedAt: "desc" },
      select: { gameweek: true, capturedAt: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: { in: ["sbs-leaderboard", "sbs-standings-full"] }, ok: true },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    // Every week this season has scores for, for the week picker. groupBy
    // (a SQL GROUP BY) rather than findMany({ distinct }), which Prisma
    // resolves by pulling every matching row into memory — ~200k rows for
    // a full season.
    prisma.scoreSnapshot.groupBy({ by: ["gameweek"], where: { seasonSlug: season.slug } }),
  ]);
  const lastSyncedAt = lastSync?.finishedAt ?? latest?.capturedAt ?? null;

  // Week picker options: only real weeks ("2026REG-03"), in order. An
  // imported "bbb3-final"-style snapshot has no week number and is skipped.
  const weekOptions = gameweekGroups
    .map((g) => ({ gameweek: g.gameweek, week: weekNumberOf(g.gameweek) }))
    .filter((w): w is { gameweek: string; week: number } => w.week != null)
    .sort((a, b) => a.week - b.week);

  // Finals = the teams SBS put in its week 17 finals league (Team.status
  // "finals", set by scripts/import-bbb3-history.ts for BBB III), ranked by
  // their week 17 score. That's exactly SBS's own finals leaderboard.
  const finalWeek = weekOptions.find((w) => w.week === 17) ?? null;
  const hasFinals =
    finalWeek != null && (await prisma.team.count({ where: { seasonSlug: season.slug, status: "finals" } })) > 0;

  const requestedWeek = weekOptions.find((w) => w.gameweek === searchParams.week) ?? null;
  // A finished season opens on its Finals (the result that matters); a live
  // season opens on the latest week, as before.
  const showFinals = hasFinals && (searchParams.week === "finals" || (!requestedWeek && !season.isActive));
  const gameweek = showFinals ? finalWeek!.gameweek : (requestedWeek?.gameweek ?? latest?.gameweek ?? null);
  const weekNum = gameweek ? weekNumberOf(gameweek) : null;

  // Weekly cash prizes are BBB IV's payout table, weeks 1-14 only — so only
  // on the live season, and never on the finals view.
  const weeklyPrizesActive =
    season.isActive && !showFinals && weekNum != null && weekNum >= 1 && weekNum <= 14;

  // The TRUE global weekly top-5 — unfiltered by level, independent of
  // whatever sort/level filter the page is currently showing — because this
  // is what real money rides on (see WEEKLY_PRIZES above), so it has to
  // reflect the actual full field, not just whichever subset of rows
  // happens to be on screen right now.
  const weeklyTop5 =
    weeklyPrizesActive && gameweek
      ? await prisma.scoreSnapshot.findMany({
          where: { seasonSlug: season.slug, gameweek },
          orderBy: { weeklyScore: "desc" },
          take: 5,
          select: { teamCardId: true },
        })
      : [];
  const weeklyPrizeRank = new Map(weeklyTop5.map((r, i) => [r.teamCardId, i + 1]));

  // Links for the week picker keep the level/sort the viewer already chose.
  function weekHref(week: string | null) {
    const params = new URLSearchParams();
    if (level !== "all") params.set("level", level);
    if (searchParams.season) params.set("season", searchParams.season);
    if (week) params.set("week", week);
    if (searchParams.sort) params.set("sort", searchParams.sort);
    if (searchParams.dir) params.set("dir", searchParams.dir);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  }

  const orderBy =
    sortKey === "rank"
      ? { rank: { sort: dir, nulls: "last" as const } }
      : sortKey === "weekly"
        ? { weeklyScore: dir }
        : { seasonScore: dir };

  const teamFilter = {
    ...(level === "all" ? {} : { level }),
    ...(showFinals ? { status: "finals" } : {}),
  };
  const rows = gameweek
    ? await prisma.scoreSnapshot.findMany({
        where: {
          seasonSlug: season.slug,
          gameweek,
          team: Object.keys(teamFilter).length > 0 ? teamFilter : undefined,
        },
        include: { team: { include: { owner: true } } },
        orderBy,
        take: 200,
      })
    : [];

  // SBS doesn't expose a per-pod rank (its own `_rank` field is global — see
  // src/lib/advancement.ts), so it has to be computed here. Scoped to just
  // the pods these 200 rows actually belong to — cheap (~10 rows/pod)
  // compared to the whole-season scan /advancement does.
  const podKeysSeen = new Set<string>();
  const podKeys: PodKey[] = [];
  for (const r of rows) {
    const key = `${r.team.level}::${r.team.leagueName}`;
    if (podKeysSeen.has(key)) continue;
    podKeysSeen.add(key);
    podKeys.push({ level: r.team.level, leagueName: r.team.leagueName });
  }
  const podRankByCard = podRankByCardId(await getPodRanks(season.slug, podKeys));

  return (
    <main>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-bold">Leaderboard</h1>
          <p className="text-sm text-zinc-400">
            {season.name}
            {gameweek
              ? `${showFinals ? " · Week 17 Finals" : ` · gameweek ${gameweek}`}${
                  season.isActive
                    ? ` · last synced ${lastSyncedAt ? lastSyncedAt.toLocaleString() : "unknown"}`
                    : ""
                }`
              : season.isActive
                ? " · no data yet — run `npm run sync:leaderboard` to pull the first snapshot."
                : " · this season isn't live-scored — see the team pages for final results."}
          </p>
          {weeklyPrizesActive && (
            <p className="mt-1 text-xs text-zinc-500">
              🏆 This week&rsquo;s top 5 by Weekly score win real cash — $
              {WEEKLY_PRIZES.join(" / $")} (SBS&rsquo;s payout table, weeks 1–14).
            </p>
          )}
        </div>
        <form action="/search" method="GET" className="flex gap-2 sm:w-64">
          <input
            type="text"
            name="q"
            placeholder="Username, wallet, or card #..."
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

      <LevelTabs current={level} extraParams={{ season: searchParams.season, week: searchParams.week }} />

      {weekOptions.length > 1 && (
        <div className="-mx-4 mt-3 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <span className="mr-1 shrink-0 text-xs uppercase tracking-wide text-zinc-500">Week</span>
          {weekOptions.map((w) => {
            const active = !showFinals && w.gameweek === gameweek;
            return (
              <Link
                key={w.gameweek}
                href={weekHref(w.gameweek)}
                className={`shrink-0 rounded-full px-3 py-1 font-mono text-sm ${
                  active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
                }`}
              >
                {String(w.week).padStart(2, "0")}
              </Link>
            );
          })}
          {hasFinals && (
            <Link
              href={weekHref("finals")}
              className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm ${
                showFinals ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
              }`}
            >
              🏆 Finals
            </Link>
          )}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full text-left text-[13px] sm:min-w-[560px] sm:text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="py-2 pl-3 pr-1 sm:px-3">
                <Link href={sortHref("rank")} className="hover:text-banana-400">
                  <span className="sm:hidden">#</span>
                  <span className="hidden sm:inline">Rank</span>
                  {sortIndicator("rank")}
                </Link>
              </th>
              <th className="px-2 py-2 sm:px-3">Owner</th>
              <th className="hidden px-2 py-2 sm:table-cell sm:px-3">Team</th>
              <th className="hidden px-2 py-2 sm:table-cell sm:px-3">Level</th>
              <th className="hidden px-2 py-2 sm:table-cell sm:px-3">Pod</th>
              <th className="px-2 py-2 sm:px-3 text-right">
                <Link href={sortHref("weekly")} className="hover:text-banana-400">
                  Weekly{sortIndicator("weekly")}
                </Link>
              </th>
              <th className="px-2 py-2 sm:px-3 text-right">
                <Link href={sortHref("season")} className="hover:text-banana-400">
                  Season{sortIndicator("season")}
                </Link>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const prizeRank = weeklyPrizesActive ? weeklyPrizeRank.get(r.teamCardId) : undefined;
              const pr = podRankByCard.get(r.teamCardId);
              const podLabel =
                !pr || pr.podRank == null ? (
                  <span className="text-zinc-500">—</span>
                ) : (
                  <span className={pr.advancing ? "text-banana-400" : "text-zinc-400"}>
                    {ordinal(pr.podRank)}/{pr.podSize}
                    {pr.advancing && " ↑"}
                  </span>
                );
              return (
                <tr key={r.teamCardId} className="border-t border-ink-600 hover:bg-ink-800/60">
                  {/* SBS's own stored `rank` field turns out to be PER-LEVEL, not
                      global across levels (confirmed 2026-09-15: on the "All"
                      view it shows e.g. two different teams both at rank 1, one
                      Pro and one HOF) — so displaying it directly produces
                      duplicate numbers whenever more than one level is mixed
                      together. This table's actual row order is always a total
                      order already (by season/weekly score, or by the raw rank
                      field when that's the sort column, ties broken by
                      teamCardId isn't guaranteed but rows are still distinct),
                      so showing the row's 1-based position here is always
                      duplicate-free and matches what "Rank" means in a
                      leaderboard: where this row sits in the list you're
                      looking at right now. */}
                  <td className="py-2 pl-3 pr-1 text-zinc-400 sm:px-3">
                    {showFinals && level === "all" && sortKey === "weekly" && dir === "desc" && i === 0 ? (
                      <span title="Champion">🏆 1</span>
                    ) : (
                      i + 1
                    )}
                  </td>
                  <td className="px-2 py-2 sm:px-3">
                    <div className="flex items-center gap-1.5 sm:gap-2">
                      <OwnerAvatar imageUrl={r.team.owner.imageUrl} />
                      <div className="min-w-0">
                        <Link
                          href={`/owner/${r.team.ownerWallet}`}
                          className="block max-w-[6.5rem] truncate hover:text-banana-400 sm:max-w-none"
                        >
                          {r.team.owner.displayName ?? shortWallet(r.team.ownerWallet)}
                        </Link>
                        {/* Phone-only second line: card # and pod standing from the hidden Team / Pod columns.
                            Level is left off to fit a 375px screen — the level tabs above cover it. */}
                        <div className="whitespace-nowrap text-xs text-zinc-500 sm:hidden">
                          <Link href={`/team/${season.slug}/${r.teamCardId}`} className="hover:text-banana-400">
                            #{r.teamCardId}
                          </Link>
                          {" · "}
                          {podLabel}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-2 py-2 text-zinc-400 sm:table-cell sm:px-3">
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
                  <td className="hidden px-2 py-2 text-zinc-400 sm:table-cell sm:px-3">{r.team.level}</td>
                  <td className="hidden px-2 py-2 sm:table-cell sm:px-3">{podLabel}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono sm:px-3">
                    {r.weeklyScore.toFixed(2)}
                    {prizeRank != null && (
                      <span
                        className={`ml-auto mt-0.5 block w-fit rounded-full px-1.5 py-0.5 text-[10px] font-semibold sm:ml-1.5 sm:mt-0 sm:inline-block sm:align-middle ${WEEKLY_PRIZE_BADGE_CLASS[prizeRank - 1]}`}
                        title={`#${prizeRank} this week — wins $${WEEKLY_PRIZES[prizeRank - 1]}`}
                      >
                        🏆 ${WEEKLY_PRIZES[prizeRank - 1]}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pl-2 pr-3 text-right font-mono font-semibold sm:px-3">
                    {r.seasonScore.toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
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

import Link from "next/link";
import { prisma } from "@/lib/db";
import { positionOf } from "@/lib/opensea";
import SeasonTabs from "@/components/SeasonTabs";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";

export const dynamic = "force-dynamic";

// Fixed display order so the position filter reads QB -> RB -> WR -> TE ->
// DST, matching src/lib/opensea.ts. FLEX/OTHER are deliberately excluded
// from the filter tabs (not useful as a lookup target), but a Team Position
// that falls into either tier is still counted under "All".
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "DST"];

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function isWalletLike(q: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(q.trim());
}

/** Resolve a free-text search string to distinct Team Position values for
 * the season, plus (if there's exactly one match, or an exact
 * case-insensitive hit) the single resolved value. Shared by the
 * single-position search and both sides of the stack search below. */
async function resolveTeamPosition(seasonSlug: string, query: string) {
  const distinctRows = await prisma.rosterSlot.findMany({
    where: { seasonSlug, value: { contains: query, mode: "insensitive" } },
    select: { value: true, slot: true },
    distinct: ["value"],
    orderBy: { value: "asc" },
    take: 50,
  });
  const exact = distinctRows.find((r) => r.value.toLowerCase() === query.toLowerCase());
  const resolved = exact?.value ?? (distinctRows.length === 1 ? distinctRows[0].value : null);
  return { matching: distinctRows, resolved };
}

/** Given a set of resolved Team Position values that must ALL be present on
 * the same team, return the per-owner leaderboard: how many of their teams
 * carry every value in the set, and what share of their portfolio that is.
 * Used for both the single-position lookup and the multi-position "stack"
 * lookup (Exposure % differs from raw Teams count once owners have
 * different total team counts — see the sort comment further down). */
async function computeExposureLeaderboard(
  seasonSlug: string,
  values: string[],
  sortKey: SortKey,
  dir: "asc" | "desc",
) {
  const slots = await prisma.rosterSlot.findMany({
    where: { seasonSlug, value: { in: values } },
    select: { teamCardId: true, value: true, team: { select: { ownerWallet: true } } },
  });

  const valuesByTeam = new Map<string, Set<string>>();
  const ownerByTeam = new Map<string, string>();
  for (const s of slots) {
    if (!valuesByTeam.has(s.teamCardId)) valuesByTeam.set(s.teamCardId, new Set());
    valuesByTeam.get(s.teamCardId)!.add(s.value);
    ownerByTeam.set(s.teamCardId, s.team.ownerWallet);
  }
  const matchingTeamIds = [...valuesByTeam.entries()]
    .filter(([, vals]) => values.every((v) => vals.has(v)))
    .map(([teamCardId]) => teamCardId);

  const countByWallet = new Map<string, number>();
  for (const teamCardId of matchingTeamIds) {
    const ownerWallet = ownerByTeam.get(teamCardId)!;
    countByWallet.set(ownerWallet, (countByWallet.get(ownerWallet) ?? 0) + 1);
  }

  const wallets = [...countByWallet.keys()];
  const [owners, totals] = await Promise.all([
    prisma.owner.findMany({ where: { wallet: { in: wallets } } }),
    prisma.team.groupBy({
      by: ["ownerWallet"],
      where: { seasonSlug, status: { not: "draft_pass" }, ownerWallet: { in: wallets } },
      _count: { _all: true },
    }),
  ]);
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));
  const totalByWallet = new Map(totals.map((t) => [t.ownerWallet, t._count._all]));

  const rows = wallets
    .map((wallet) => {
      const teams = countByWallet.get(wallet)!;
      const totalDrafted = totalByWallet.get(wallet) ?? teams;
      return {
        wallet,
        displayName: ownerByWallet.get(wallet)?.displayName ?? null,
        teams,
        totalDrafted,
        pct: totalDrafted > 0 ? (teams / totalDrafted) * 100 : 0,
      };
    })
    .sort((a, b) => {
      if (sortKey === "value") {
        const an = a.displayName ?? a.wallet;
        const bn = b.displayName ?? b.wallet;
        return dir === "asc" ? an.localeCompare(bn) : bn.localeCompare(an);
      }
      const av = sortKey === "teams" ? a.teams : a.pct;
      const bv = sortKey === "teams" ? b.teams : b.pct;
      return dir === "asc" ? av - bv || a.wallet.localeCompare(b.wallet) : bv - av || a.wallet.localeCompare(b.wallet);
    });

  return { totalTeams: matchingTeamIds.length, ownerCount: countByWallet.size, rows };
}

type SortKey = "value" | "teams" | "pct";
const SORT_DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = { value: "asc", teams: "desc", pct: "desc" };
function isSortKey(v: string | undefined): v is SortKey {
  return v === "value" || v === "teams" || v === "pct";
}

export default async function ExposurePage({
  searchParams,
}: {
  searchParams: {
    q?: string;
    season?: string;
    position?: string;
    pos?: string;
    stackA?: string;
    stackB?: string;
    sort?: string;
    dir?: string;
  };
}) {
  const q = (searchParams.q ?? "").trim();
  const posQuery = (searchParams.pos ?? "").trim();
  const stackAQuery = (searchParams.stackA ?? "").trim();
  const stackBQuery = (searchParams.stackB ?? "").trim();
  const position = searchParams.position ?? "all";
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  // Three independent search modes on this page, in priority order (most
  // specific ask wins when more than one box has text in it):
  //   1. STACK  (stackA/stackB, e.g. "NE QB" + "NE WR1") — which owners
  //      have drafted BOTH team-positions on the same team.
  //   2. POSITION (pos, e.g. "MIN WR1") — which owners have drafted just
  //      that one team-position, anywhere.
  //   3. OWNER (q, username/wallet) — one owner's full exposure breakdown.
  const activeMode: "stack" | "pos" | "owner" | "none" = stackAQuery
    ? "stack"
    : posQuery
      ? "pos"
      : q
        ? "owner"
        : "none";

  const sortKey: SortKey = isSortKey(searchParams.sort) ? searchParams.sort : "teams";
  const dir: "asc" | "desc" = searchParams.dir === "asc" || searchParams.dir === "desc"
    ? searchParams.dir
    : SORT_DEFAULT_DIR[sortKey];

  const extraParams =
    activeMode === "stack"
      ? { stackA: stackAQuery, stackB: stackBQuery || undefined, sort: searchParams.sort, dir: searchParams.dir }
      : activeMode === "pos"
        ? { pos: posQuery, sort: searchParams.sort, dir: searchParams.dir }
        : { q, position: position !== "all" ? position : undefined, sort: searchParams.sort, dir: searchParams.dir };

  // Sortable result columns — shared by all three result tables below (only
  // one renders at a time, so one pair of query params covers all of them):
  // "value" is the leftmost column (Team Position alpha in owner-mode,
  // Owner name alpha in position/stack-mode), "teams" is the raw count,
  // "pct" is Exposure %. Teams and % sort identically within the owner-mode
  // table (same divisor for every row there) but differ in position/stack
  // mode, where each owner has a different total team count.
  function sortHref(column: SortKey) {
    const params = new URLSearchParams();
    params.set("season", season.slug);
    if (activeMode === "stack") {
      if (stackAQuery) params.set("stackA", stackAQuery);
      if (stackBQuery) params.set("stackB", stackBQuery);
    } else if (activeMode === "pos") {
      params.set("pos", posQuery);
    } else {
      if (q) params.set("q", q);
      if (position !== "all") params.set("position", position);
    }
    params.set("sort", column);
    params.set("dir", column === sortKey && dir === SORT_DEFAULT_DIR[column]
      ? (dir === "asc" ? "desc" : "asc")
      : SORT_DEFAULT_DIR[column]);
    return `/exposure?${params.toString()}`;
  }

  function sortIndicator(column: SortKey) {
    if (column !== sortKey) return null;
    return <span className="ml-1 text-banana-400">{dir === "asc" ? "▲" : "▼"}</span>;
  }

  // --- POSITION mode (single Team Position) ---
  let matchingValues: { value: string; slot: string }[] = [];
  let resolvedPos: string | null = null;
  let posTier = "";
  let posTotalTeams = 0;
  let posOwnerCount = 0;
  let posRows: { wallet: string; displayName: string | null; teams: number; totalDrafted: number; pct: number }[] = [];

  if (activeMode === "pos") {
    const { matching, resolved } = await resolveTeamPosition(season.slug, posQuery);
    matchingValues = matching;
    resolvedPos = resolved;
    if (resolvedPos) {
      posTier = matching.find((m) => m.value === resolvedPos)?.slot
        ? positionOf(matching.find((m) => m.value === resolvedPos)!.slot)
        : "";
      const result = await computeExposureLeaderboard(season.slug, [resolvedPos], sortKey, dir);
      posTotalTeams = result.totalTeams;
      posOwnerCount = result.ownerCount;
      posRows = result.rows;
    }
  }

  // --- STACK mode (two Team Positions that must both be on the same team) ---
  let matchingA: { value: string; slot: string }[] = [];
  let matchingB: { value: string; slot: string }[] = [];
  let resolvedA: string | null = null;
  let resolvedB: string | null = null;
  let stackTierA = "";
  let stackTierB = "";
  let stackTotalTeams = 0;
  let stackOwnerCount = 0;
  let stackRows: { wallet: string; displayName: string | null; teams: number; totalDrafted: number; pct: number }[] = [];

  if (activeMode === "stack" && stackBQuery) {
    const [resA, resB] = await Promise.all([
      resolveTeamPosition(season.slug, stackAQuery),
      resolveTeamPosition(season.slug, stackBQuery),
    ]);
    matchingA = resA.matching;
    resolvedA = resA.resolved;
    matchingB = resB.matching;
    resolvedB = resB.resolved;

    if (resolvedA && resolvedB && resolvedA !== resolvedB) {
      stackTierA = matchingA.find((m) => m.value === resolvedA)?.slot
        ? positionOf(matchingA.find((m) => m.value === resolvedA)!.slot)
        : "";
      stackTierB = matchingB.find((m) => m.value === resolvedB)?.slot
        ? positionOf(matchingB.find((m) => m.value === resolvedB)!.slot)
        : "";
      const result = await computeExposureLeaderboard(season.slug, [resolvedA, resolvedB], sortKey, dir);
      stackTotalTeams = result.totalTeams;
      stackOwnerCount = result.ownerCount;
      stackRows = result.rows;
    }
  }

  // --- OWNER mode (search by username/wallet) ---
  // Resolve `q` to exactly one Owner — a direct wallet match short-circuits
  // the ambiguous-search path since a wallet is always unique.
  const owners =
    activeMode === "owner"
      ? isWalletLike(q)
        ? await prisma.owner.findMany({ where: { wallet: q.toLowerCase() } })
        : await prisma.owner.findMany({
            where: {
              OR: [
                { displayName: { contains: q, mode: "insensitive" } },
                { wallet: { contains: q.toLowerCase() } },
              ],
            },
            take: 25,
          })
      : [];

  const owner = owners.length === 1 ? owners[0] : null;

  let totalDrafted = 0;
  let rows: { value: string; position: string; count: number; pct: number }[] = [];
  let rosterDataMissing = false;

  if (owner) {
    const teams = await prisma.team.findMany({
      where: { ownerWallet: owner.wallet, seasonSlug: season.slug, status: { not: "draft_pass" } },
      include: { rosterSlots: true },
    });
    totalDrafted = teams.length;

    const counts = new Map<string, { count: number; position: string }>();
    let anyRosterData = false;
    for (const t of teams) {
      if (t.rosterSlots.length > 0) anyRosterData = true;
      const seenThisTeam = new Set<string>();
      for (const rs of t.rosterSlots) {
        if (seenThisTeam.has(rs.value)) continue; // one team can't double-count the same team-position
        seenThisTeam.add(rs.value);
        const entry = counts.get(rs.value) ?? { count: 0, position: positionOf(rs.slot) };
        entry.count += 1;
        counts.set(rs.value, entry);
      }
    }
    rosterDataMissing = totalDrafted > 0 && !anyRosterData;

    rows = [...counts.entries()]
      .map(([value, c]) => ({ value, position: c.position, count: c.count, pct: (c.count / totalDrafted) * 100 }))
      .filter((r) => position === "all" || r.position === position)
      .sort((a, b) => {
        if (sortKey === "value") {
          return dir === "asc" ? a.value.localeCompare(b.value) : b.value.localeCompare(a.value);
        }
        const av = sortKey === "teams" ? a.count : a.pct;
        const bv = sortKey === "teams" ? b.count : b.pct;
        return dir === "asc" ? av - bv || a.value.localeCompare(b.value) : bv - av || a.value.localeCompare(b.value);
      });
  }

  const presentPositions = POSITION_ORDER; // shown regardless of data so the filter UI doesn't jump around

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Exposure</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Look up an owner to see which Team Positions they&rsquo;re most exposed to across their
        drafted teams — since SBS teams draft team-positions (like &ldquo;CHI QB&rdquo;) instead of
        individual players, that&rsquo;s the unit exposure is measured in here.
      </p>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
        <form action="/exposure" method="GET" className="flex gap-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Search an owner</label>
            <div className="flex gap-2">
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="Username or wallet..."
                autoFocus={activeMode === "none"}
                className="w-full max-w-sm rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
              />
              <input type="hidden" name="season" value={season.slug} />
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-banana-400 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Look up
              </button>
            </div>
          </div>
        </form>

        <form action="/exposure" method="GET" className="flex gap-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Search a Team Position</label>
            <div className="flex gap-2">
              <input
                type="text"
                name="pos"
                defaultValue={posQuery}
                placeholder="e.g. MIN WR1..."
                autoFocus={activeMode === "pos"}
                className="w-full max-w-sm rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
              />
              <input type="hidden" name="season" value={season.slug} />
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-banana-400 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Who&rsquo;s exposed?
              </button>
            </div>
          </div>
        </form>

        <form action="/exposure" method="GET" className="flex gap-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Search a stack (two Team Positions)</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                name="stackA"
                defaultValue={stackAQuery}
                placeholder="e.g. NE QB..."
                autoFocus={activeMode === "stack"}
                className="w-full max-w-[10rem] rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
              />
              <span className="text-zinc-500">+</span>
              <input
                type="text"
                name="stackB"
                defaultValue={stackBQuery}
                placeholder="e.g. NE WR1..."
                className="w-full max-w-[10rem] rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
              />
              <input type="hidden" name="season" value={season.slug} />
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-banana-400 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Who&rsquo;s stacked?
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="mb-4">
        <SeasonTabs seasons={seasons} current={season.slug} basePath="/exposure" extraParams={extraParams} />
      </div>

      {activeMode === "none" && (
        <p className="text-sm text-zinc-500">
          Search for an owner by username or wallet, a Team Position (like &ldquo;MIN WR1&rdquo;), or a
          stack of two Team Positions (like &ldquo;NE QB&rdquo; + &ldquo;NE WR1&rdquo;) to get started.
        </p>
      )}

      {/* --- STACK mode --- */}
      {activeMode === "stack" && !stackBQuery && (
        <p className="text-sm text-zinc-500">Enter a second Team Position to see who&rsquo;s stacked.</p>
      )}

      {activeMode === "stack" && stackBQuery && matchingA.length === 0 && (
        <p className="text-sm text-zinc-500">No Team Position found matching &ldquo;{stackAQuery}&rdquo;.</p>
      )}

      {activeMode === "stack" && stackBQuery && matchingA.length > 0 && matchingB.length === 0 && (
        <p className="text-sm text-zinc-500">No Team Position found matching &ldquo;{stackBQuery}&rdquo;.</p>
      )}

      {activeMode === "stack" && stackBQuery && matchingA.length > 1 && !resolvedA && (
        <div className="mb-4 overflow-x-auto rounded-lg border border-ink-600">
          <p className="border-b border-ink-600 bg-ink-800 px-3 py-2 text-xs text-zinc-400">
            Multiple Team Positions match &ldquo;{stackAQuery}&rdquo; for the first slot — pick one:
          </p>
          <table className="w-full sm:min-w-[420px] text-left text-sm">
            <tbody>
              {matchingA.map((m) => (
                <tr key={m.value} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3">
                    <Link
                      href={`/exposure?stackA=${encodeURIComponent(m.value)}&stackB=${encodeURIComponent(stackBQuery)}&season=${season.slug}`}
                      className="hover:text-banana-400"
                    >
                      {m.value}
                    </Link>
                    <span className="ml-2 text-xs text-zinc-500">{positionOf(m.slot)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeMode === "stack" && stackBQuery && resolvedA && matchingB.length > 1 && !resolvedB && (
        <div className="mb-4 overflow-x-auto rounded-lg border border-ink-600">
          <p className="border-b border-ink-600 bg-ink-800 px-3 py-2 text-xs text-zinc-400">
            Multiple Team Positions match &ldquo;{stackBQuery}&rdquo; for the second slot — pick one:
          </p>
          <table className="w-full sm:min-w-[420px] text-left text-sm">
            <tbody>
              {matchingB.map((m) => (
                <tr key={m.value} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3">
                    <Link
                      href={`/exposure?stackA=${encodeURIComponent(resolvedA!)}&stackB=${encodeURIComponent(m.value)}&season=${season.slug}`}
                      className="hover:text-banana-400"
                    >
                      {m.value}
                    </Link>
                    <span className="ml-2 text-xs text-zinc-500">{positionOf(m.slot)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeMode === "stack" && resolvedA && resolvedB && resolvedA === resolvedB && (
        <p className="text-sm text-zinc-500">Pick two different Team Positions to see a stack.</p>
      )}

      {activeMode === "stack" && resolvedA && resolvedB && resolvedA !== resolvedB && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {resolvedA} + {resolvedB}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {stackTierA} + {stackTierB} · stacked on {stackTotalTeams} team{stackTotalTeams === 1 ? "" : "s"}{" "}
                across {stackOwnerCount} owner{stackOwnerCount === 1 ? "" : "s"} · {season.name}
              </span>
            </h2>
          </div>

          {stackTotalTeams === 0 && (
            <p className="text-sm text-zinc-500">
              No teams have drafted both {resolvedA} and {resolvedB} in {season.name}.
            </p>
          )}

          {stackTotalTeams > 0 && (
            <div className="overflow-x-auto rounded-lg border border-ink-600">
              <table className="w-full sm:min-w-[420px] text-left text-sm">
                <thead className="bg-ink-800 text-zinc-400">
                  <tr>
                    <th className="px-2 py-2 sm:px-3">#</th>
                    <th className="px-2 py-2 sm:px-3">
                      <Link href={sortHref("value")} className="hover:text-banana-400">
                        Owner{sortIndicator("value")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("teams")} className="hover:text-banana-400">
                        Teams{sortIndicator("teams")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("pct")} className="hover:text-banana-400">
                        Exposure{sortIndicator("pct")}
                      </Link>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stackRows.map((r, i) => (
                    <tr key={r.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                      <td className="px-2 py-2 sm:px-3 text-zinc-400">{i + 1}</td>
                      <td className="px-2 py-2 sm:px-3">
                        <Link href={`/owner/${r.wallet}`} className="hover:text-banana-400">
                          {r.displayName ?? shortWallet(r.wallet)}
                        </Link>
                      </td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">{r.teams}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* --- POSITION mode --- */}
      {activeMode === "pos" && matchingValues.length === 0 && (
        <p className="text-sm text-zinc-500">No Team Position found matching &ldquo;{posQuery}&rdquo;.</p>
      )}

      {activeMode === "pos" && !resolvedPos && matchingValues.length > 1 && (
        <div className="overflow-x-auto rounded-lg border border-ink-600">
          <p className="border-b border-ink-600 bg-ink-800 px-3 py-2 text-xs text-zinc-400">
            Multiple Team Positions match &ldquo;{posQuery}&rdquo; — pick one:
          </p>
          <table className="w-full sm:min-w-[420px] text-left text-sm">
            <tbody>
              {matchingValues.map((m) => (
                <tr key={m.value} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3">
                    <Link
                      href={`/exposure?pos=${encodeURIComponent(m.value)}&season=${season.slug}`}
                      className="hover:text-banana-400"
                    >
                      {m.value}
                    </Link>
                    <span className="ml-2 text-xs text-zinc-500">{positionOf(m.slot)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeMode === "pos" && resolvedPos && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {resolvedPos}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {posTier} · drafted in {posTotalTeams} team{posTotalTeams === 1 ? "" : "s"} across{" "}
                {posOwnerCount} owner{posOwnerCount === 1 ? "" : "s"} · {season.name}
              </span>
            </h2>
          </div>

          {posTotalTeams === 0 && (
            <p className="text-sm text-zinc-500">No teams have drafted {resolvedPos} in {season.name}.</p>
          )}

          {posTotalTeams > 0 && (
            <div className="overflow-x-auto rounded-lg border border-ink-600">
              <table className="w-full sm:min-w-[420px] text-left text-sm">
                <thead className="bg-ink-800 text-zinc-400">
                  <tr>
                    <th className="px-2 py-2 sm:px-3">#</th>
                    <th className="px-2 py-2 sm:px-3">
                      <Link href={sortHref("value")} className="hover:text-banana-400">
                        Owner{sortIndicator("value")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("teams")} className="hover:text-banana-400">
                        Teams{sortIndicator("teams")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("pct")} className="hover:text-banana-400">
                        Exposure{sortIndicator("pct")}
                      </Link>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {posRows.map((r, i) => (
                    <tr key={r.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                      <td className="px-2 py-2 sm:px-3 text-zinc-400">{i + 1}</td>
                      <td className="px-2 py-2 sm:px-3">
                        <Link href={`/owner/${r.wallet}`} className="hover:text-banana-400">
                          {r.displayName ?? shortWallet(r.wallet)}
                        </Link>
                      </td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">{r.teams}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono text-zinc-400">{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* --- OWNER mode --- */}
      {activeMode === "owner" && owners.length === 0 && (
        <p className="text-sm text-zinc-500">No owner found matching &ldquo;{q}&rdquo;.</p>
      )}

      {activeMode === "owner" && owners.length > 1 && (
        <div className="overflow-x-auto rounded-lg border border-ink-600">
          <p className="border-b border-ink-600 bg-ink-800 px-3 py-2 text-xs text-zinc-400">
            Multiple owners match &ldquo;{q}&rdquo; — pick one:
          </p>
          <table className="w-full sm:min-w-[420px] text-left text-sm">
            <tbody>
              {owners.map((o) => (
                <tr key={o.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3">
                    <Link href={`/exposure?q=${o.wallet}&season=${season.slug}`} className="hover:text-banana-400">
                      {o.displayName ?? shortWallet(o.wallet)}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-zinc-500">{shortWallet(o.wallet)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeMode === "owner" && owner && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              <Link href={`/owner/${owner.wallet}`} className="hover:text-banana-400">
                {owner.displayName ?? shortWallet(owner.wallet)}
              </Link>
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {totalDrafted} drafted team{totalDrafted === 1 ? "" : "s"} · {season.name}
              </span>
            </h2>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {["all", ...presentPositions].map((p) => {
              const active = p === position || (p === "all" && position === "all");
              const params = new URLSearchParams({ q, season: season.slug });
              if (p !== "all") params.set("position", p);
              if (searchParams.sort) params.set("sort", searchParams.sort);
              if (searchParams.dir) params.set("dir", searchParams.dir);
              return (
                <Link
                  key={p}
                  href={`/exposure?${params.toString()}`}
                  className={`rounded-full px-3 py-1 text-sm ${
                    active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
                  }`}
                >
                  {p === "all" ? "All" : p}
                </Link>
              );
            })}
          </div>

          {totalDrafted === 0 && (
            <p className="text-sm text-zinc-500">
              No drafted teams found for {owner.displayName ?? shortWallet(owner.wallet)} in {season.name}.
            </p>
          )}

          {rosterDataMissing && (
            <p className="mb-3 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-xs text-zinc-400">
              Roster data hasn&rsquo;t been synced for {season.name} yet — run <code>npm run sync:collection</code>{" "}
              (or <code>npm run import:season</code> for a historical season) to populate exposure data, then
              refresh this page.
            </p>
          )}

          {totalDrafted > 0 && !rosterDataMissing && (
            <div className="overflow-x-auto rounded-lg border border-ink-600">
              <table className="w-full sm:min-w-[420px] text-left text-sm">
                <thead className="bg-ink-800 text-zinc-400">
                  <tr>
                    <th className="px-2 py-2 sm:px-3">
                      <Link href={sortHref("value")} className="hover:text-banana-400">
                        Team Position{sortIndicator("value")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3">Pos</th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("teams")} className="hover:text-banana-400">
                        Teams{sortIndicator("teams")}
                      </Link>
                    </th>
                    <th className="px-2 py-2 sm:px-3 text-right">
                      <Link href={sortHref("pct")} className="hover:text-banana-400">
                        Exposure{sortIndicator("pct")}
                      </Link>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.value} className="border-t border-ink-600">
                      <td className="px-2 py-2 sm:px-3 font-medium">{r.value}</td>
                      <td className="px-2 py-2 sm:px-3 text-zinc-400">{r.position}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono">{r.count}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-zinc-500">
                        No {position === "all" ? "" : `${position} `}exposure to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

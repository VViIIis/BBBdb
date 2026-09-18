import { prisma } from "@/lib/db";
import WeekTabs from "@/components/WeekTabs";
import GameBoxScoreCard from "@/components/GameBoxScoreCard";

export const dynamic = "force-dynamic";

// How many week-pills to show — recent enough to browse a few weeks back
// (the "keep a running archive" scope Jack chose) without the tab row
// growing unbounded as a season goes on.
const WEEK_TABS_LIMIT = 10;

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: { season?: string; week?: string };
}) {
  const weekRows = await prisma.nflGame.findMany({
    where: { seasonType: 2 },
    select: { season: true, week: true },
    distinct: ["season", "week"],
    orderBy: [{ season: "desc" }, { week: "desc" }],
    take: WEEK_TABS_LIMIT,
  });

  const requestedSeason = Number(searchParams.season);
  const requestedWeek = Number(searchParams.week);
  const current =
    weekRows.find((w) => w.season === requestedSeason && w.week === requestedWeek) ?? weekRows[0];

  if (!current) {
    return (
      <main>
        <h1 className="mb-1 text-2xl font-bold">Scores</h1>
        <p className="text-sm text-zinc-400">
          No games synced yet — run <code className="text-zinc-300">npm run sync:scores</code>.
        </p>
      </main>
    );
  }

  const [games, lastSync] = await Promise.all([
    prisma.nflGame.findMany({
      where: { season: current.season, week: current.week, seasonType: 2 },
      orderBy: { kickoff: "asc" },
      include: { slots: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: "nfl-scores", ok: true },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
  ]);

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Scores</h1>
      <p className="mb-4 text-sm text-zinc-400">
        SBS&rsquo;s &ldquo;Team Positions&rdquo; format, computed from each game&rsquo;s real NFL box score — the
        top performer at each slot (QB / RB1 / RB2 / WR1 / WR2 / TE / D-ST) wins it, full PPR.{" "}
        {lastSync
          ? `Last synced ${lastSync.finishedAt!.toLocaleString()}.`
          : "No successful sync yet."}{" "}
        Final games only — a game still in progress shows as pending until it ends. Unofficial fan project, not
        affiliated with SBS Fantasy.
      </p>
      <div className="mb-6">
        <WeekTabs weeks={weekRows} current={current} />
      </div>
      <div className="flex flex-col gap-4">
        {games.map((g) => (
          <GameBoxScoreCard key={g.espnEventId} game={g} />
        ))}
        {games.length === 0 && <p className="text-sm text-zinc-500">No games found for this week.</p>}
      </div>
    </main>
  );
}

import { prisma } from "@/lib/db";

/**
 * Powers the /stats tab: season-long "which real NFL team is winning this
 * SBS slot" leaderboards, one per Team Position (QB/RB1/RB2/WR1/WR2/TE/DST)
 * — the natural roll-up of the per-game rows /scores already writes (see
 * src/lib/jobs/syncScores.ts). Deliberately a plain in-memory rollup rather
 * than a Prisma groupBy: a groupBy can sum points fine, but "which game was
 * this team's BEST performance at this slot" needs the actual row, not just
 * an aggregate — same reasoning src/lib/advancement.ts's rollupByOwner()
 * uses for its own team-count rollups.
 */
export interface SlotLeaderRow {
  team: string;
  totalPoints: number;
  games: number;
  avgPoints: number;
  bestGame: {
    points: number;
    playerName: string | null;
    week: number;
    opponent: string;
  } | null;
}

export async function getSlotLeaders(season: number, slot: string): Promise<SlotLeaderRow[]> {
  const rows = await prisma.teamPositionScore.findMany({
    where: { slot, game: { season, seasonType: 2, status: "final" } },
    select: {
      team: true,
      points: true,
      playerName: true,
      game: { select: { week: true, awayTeam: true, homeTeam: true } },
    },
  });

  const byTeam = new Map<string, SlotLeaderRow>();
  for (const r of rows) {
    let entry = byTeam.get(r.team);
    if (!entry) {
      entry = { team: r.team, totalPoints: 0, games: 0, avgPoints: 0, bestGame: null };
      byTeam.set(r.team, entry);
    }
    entry.totalPoints += r.points;
    entry.games += 1;
    const opponent = r.game.awayTeam === r.team ? r.game.homeTeam : r.game.awayTeam;
    if (!entry.bestGame || r.points > entry.bestGame.points) {
      entry.bestGame = { points: r.points, playerName: r.playerName, week: r.game.week, opponent };
    }
  }

  const list = [...byTeam.values()];
  for (const e of list) e.avgPoints = e.games > 0 ? e.totalPoints / e.games : 0;
  return list;
}

/** Distinct regular-season years that have at least one synced game — powers the season picker. */
export async function getStatsSeasons(): Promise<number[]> {
  const rows = await prisma.nflGame.findMany({
    where: { seasonType: 2 },
    select: { season: true },
    distinct: ["season"],
    orderBy: { season: "desc" },
  });
  return rows.map((r) => r.season);
}

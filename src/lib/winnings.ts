import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/db";

/**
 * SBS's weekly payout table for BBB IV (confirmed on sbsfantasy.com/teams
 * 2026-09-25): every week 1-14, the top 5 Weekly scores across the whole
 * field win these amounts. Index 0 = 1st place.
 */
export const WEEKLY_PRIZES = [250, 100, 50, 35, 20];
export const LAST_PRIZE_WEEK = 14;

// "2026REG-03" -> 3. Anything else (e.g. "bbb3-final") -> null.
export function weekNumberOf(gameweek: string): number | null {
  const m = gameweek.match(/^\d{4}REG-(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * When each week's games are over: the Tuesday morning after Monday Night
 * Football (08:00 UTC is ~3am Eastern, after any MNF game ends). 2026's
 * opener was Wed Sep 9, so week 1 ended after MNF on Mon Sep 14.
 */
const WEEK1_END_UTC: Record<string, string> = {
  bbb4: "2026-09-15T08:00:00Z",
};
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekEnd(seasonSlug: string, week: number): number | null {
  const w1 = WEEK1_END_UTC[seasonSlug];
  return w1 ? Date.parse(w1) + (week - 1) * WEEK_MS : null;
}

export interface WeeklyWinner {
  place: number; // 1-5; tied teams share the same place
  tiedWith: number; // how many teams share this place (1 = no tie)
  teamCardId: string;
  leagueName: string;
  level: string;
  weeklyScore: number;
  prize: number; // dollars, split evenly on a tie
  ownerWallet: string; // who held the team when the week ended
}

export interface WeekResult {
  week: number;
  gameweek: string;
  final: boolean; // false = games still in progress, standings can change
  winners: WeeklyWinner[];
}

export interface Earner {
  wallet: string;
  total: number;
  cashes: number;
  firsts: number;
  bestPlace: number;
  weeks: { week: number; place: number; prize: number }[];
}

export interface Winnings {
  weeks: WeekResult[]; // newest first
  earners: Earner[]; // final weeks only, most money first
  totalPaid: number;
  finalWeeks: number;
}

async function computeWinnings(seasonSlug: string): Promise<Winnings> {
  // Top 5 Weekly scores in every regular-season week, with ties: RANK()
  // gives tied scores the same rank, so a tie for 5th keeps every tied team.
  const rows = await prisma.$queryRaw<
    { gameweek: string; teamCardId: string; weeklyScore: number; place: bigint }[]
  >`
    SELECT "gameweek", "teamCardId", "weeklyScore", "place" FROM (
      SELECT "gameweek", "teamCardId", "weeklyScore",
             RANK() OVER (PARTITION BY "gameweek" ORDER BY round("weeklyScore"::numeric, 2) DESC) AS "place"
      FROM "ScoreSnapshot"
      WHERE "seasonSlug" = ${seasonSlug} AND "gameweek" LIKE '%REG-%'
    ) ranked
    WHERE "place" <= ${WEEKLY_PRIZES.length}
  `;

  const byGameweek = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byGameweek.get(r.gameweek) ?? [];
    list.push(r);
    byGameweek.set(r.gameweek, list);
  }
  const allWeeks = [...byGameweek.keys()]
    .map((gameweek) => ({ gameweek, week: weekNumberOf(gameweek) }))
    .filter((w): w is { gameweek: string; week: number } => w.week != null);
  const latestWeek = Math.max(0, ...allWeeks.map((w) => w.week));
  const now = Date.now();

  const cardIds = [...new Set(rows.map((r) => r.teamCardId))];
  const [teams, sales] = await Promise.all([
    prisma.team.findMany({
      where: { seasonSlug, cardId: { in: cardIds } },
      select: { cardId: true, ownerWallet: true, leagueName: true, level: true },
    }),
    prisma.sale.findMany({
      where: { seasonSlug, teamCardId: { in: cardIds } },
      orderBy: { occurredAt: "asc" },
      select: { teamCardId: true, fromWallet: true, occurredAt: true },
    }),
  ]);
  const teamById = new Map(teams.map((t) => [t.cardId, t]));
  const salesByCard = new Map<string, { fromWallet: string; at: number }[]>();
  for (const s of sales) {
    const list = salesByCard.get(s.teamCardId) ?? [];
    list.push({ fromWallet: s.fromWallet.toLowerCase(), at: s.occurredAt.getTime() });
    salesByCard.set(s.teamCardId, list);
  }

  // Prize money goes to whoever held the team when the week ended. If the
  // team has been sold since, that's the seller in the first sale after
  // that moment; otherwise it's the current owner.
  function ownerAt(cardId: string, at: number | null): string {
    const current = (teamById.get(cardId)?.ownerWallet ?? "").toLowerCase();
    if (at == null) return current;
    const later = salesByCard.get(cardId)?.find((s) => s.at > at);
    return later ? later.fromWallet : current;
  }

  const weeks: WeekResult[] = [];
  for (const { gameweek, week } of allWeeks) {
    if (week < 1 || week > LAST_PRIZE_WEEK) continue;
    const ranked = byGameweek.get(gameweek)!.filter((r) => r.weeklyScore > 0);
    if (ranked.length === 0) continue; // week hasn't kicked off yet
    const end = weekEnd(seasonSlug, week);
    const final = week < latestWeek || (end != null && now >= end);

    const countAtPlace = new Map<number, number>();
    for (const r of ranked) countAtPlace.set(Number(r.place), (countAtPlace.get(Number(r.place)) ?? 0) + 1);

    const winners: WeeklyWinner[] = ranked
      .map((r) => {
        const place = Number(r.place);
        const tiedWith = countAtPlace.get(place)!;
        // Tied teams split the prizes for every place they cover, e.g. two
        // teams tied for 4th split 4th + 5th: ($35 + $20) / 2 each.
        const pool = WEEKLY_PRIZES.slice(place - 1, place - 1 + tiedWith).reduce((a, b) => a + b, 0);
        const team = teamById.get(r.teamCardId);
        return {
          place,
          tiedWith,
          teamCardId: r.teamCardId,
          leagueName: team?.leagueName ?? "",
          level: team?.level ?? "",
          weeklyScore: r.weeklyScore,
          prize: Math.round((pool / tiedWith) * 100) / 100,
          ownerWallet: ownerAt(r.teamCardId, final ? end : null),
        };
      })
      .sort((a, b) => a.place - b.place || b.weeklyScore - a.weeklyScore);
    weeks.push({ week, gameweek, final, winners });
  }
  weeks.sort((a, b) => b.week - a.week);

  const earnerByWallet = new Map<string, Earner>();
  let totalPaid = 0;
  for (const w of weeks) {
    if (!w.final) continue;
    for (const win of w.winners) {
      totalPaid += win.prize;
      const e = earnerByWallet.get(win.ownerWallet) ?? {
        wallet: win.ownerWallet,
        total: 0,
        cashes: 0,
        firsts: 0,
        bestPlace: 99,
        weeks: [],
      };
      e.total += win.prize;
      e.cashes += 1;
      if (win.place === 1) e.firsts += 1;
      e.bestPlace = Math.min(e.bestPlace, win.place);
      e.weeks.push({ week: w.week, place: win.place, prize: win.prize });
      earnerByWallet.set(win.ownerWallet, e);
    }
  }
  const earners = [...earnerByWallet.values()]
    .map((e) => ({ ...e, total: Math.round(e.total * 100) / 100, weeks: e.weeks.sort((a, b) => a.week - b.week) }))
    .sort((a, b) => b.total - a.total || b.firsts - a.firsts || a.bestPlace - b.bestPlace);

  return { weeks, earners, totalPaid: Math.round(totalPaid * 100) / 100, finalWeeks: weeks.filter((w) => w.final).length };
}

// Cached for 5 minutes like the leaderboard's season summary: it ranks every
// snapshot in the season, and the answer only changes when a sync runs.
export const getWinnings = unstable_cache(computeWinnings, ["weekly-winnings"], { revalidate: 300 });

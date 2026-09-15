import { prisma } from "@/lib/db";

/**
 * Pod advancement rules, confirmed against sbsfantasy.com/faq (2026-09-15)
 * plus a live check of /api/standings:
 *
 *   - Every draft (pod) is a 10-team league. Weeks 1-14 score CUMULATIVELY
 *     within the pod, and the TOP 2 by season score advance to a fresh
 *     Week 15 pod -> Week 16 pod -> Week 17 finals.
 *   - This "top 2 of 10" rule is UNIFORM across all 5 levels
 *     (Pro/Hall of Fame/Jackpot/JackHOF/Founder):
 *       - Jackpot: 1st place skips straight to the Week 17 finals instead
 *         of the Week 15 pod; 2nd place still advances normally "like any
 *         other league." Both are still the pod's top 2.
 *       - Hall of Fame: "the top 2 in your HOF pod (Weeks 1-14) advance to
 *         the regular playoffs. On top of that, only the 1st-place team
 *         ALSO advances into a separate HOF bonus-prize track." Top 2 still
 *         advance the normal way; 1st just gets an extra perk.
 *       - JackHOF: combines both perks for 1st place (finals + HOF bonus
 *         track); 2nd place advances normally, consistent with the other
 *         two rules it combines.
 *       - Founder: not a separate pod structure at all — just a normal pod
 *         that happens to include one of the streamed "founder" drafts,
 *         with its own side raffle. Same top-2-of-10 rule underneath.
 *     So one uniform "podRank <= 2" check is correct for every level.
 *
 *   - SBS's own `_rank` field (as returned by /api/standings, the per-pod
 *     endpoint) is GLOBAL leaderboard rank, NOT a position within the pod —
 *     confirmed live 2026-09-15 by fetching a real 10-team pod and seeing
 *     `_rank` values like 118/2849/3809/... instead of 1-10. There is no
 *     stored per-pod rank anywhere, so it has to be computed here: group a
 *     season's drafted teams by (level, leagueName) — same grouping key the
 *     /pod page uses and for the same reason (see that page's comment) —
 *     and sort each group by its latest seasonScore.
 */

export interface PodRankedTeam {
  cardId: string;
  ownerWallet: string;
  level: string;
  leagueId: string;
  leagueName: string;
  /** 1-based position within the pod by season score, highest first. Null
   * if this team has no score snapshot yet (sorts last within its pod). */
  podRank: number | null;
  /** How many (non-draft_pass) teams were ranked in this pod. */
  podSize: number;
  /** True iff podRank is 1 or 2 — see the rules above. Always false for an
   * unscored team. */
  advancing: boolean;
  weeklyScore: number | null;
  seasonScore: number | null;
}

export type PodKey = { level: string; leagueName: string };

/**
 * Ranks drafted (status != "draft_pass") teams within their pod, using each
 * team's most recent score snapshot (same "latest by capturedAt" approach
 * the /pod page already uses — robust to teams whose absolute-latest sync
 * happened at a slightly different run than their podmates').
 *
 * Pass `pods` to scope the scan to specific (level, leagueName) pairs —
 * cheap (~10 rows per pod), meant for badging a handful of teams already
 * being shown on some other page (leaderboard rows, recent sales, one
 * owner's roster). Omit it to rank EVERY pod in the season — this is the
 * expensive, whole-season scan only the site-wide /advancement leaderboard
 * needs.
 */
export async function getPodRanks(seasonSlug: string, pods?: PodKey[]): Promise<PodRankedTeam[]> {
  if (pods && pods.length === 0) return [];

  // Naively turning `pods` into `OR: pods.map(p => ({level, leagueName}))`
  // blows up once `pods` gets long (confirmed live 2026-09-15: the main
  // leaderboard's ~200 rows can span ~200 distinct pods) — Prisma has to
  // generate that as a long chain of compound OR conditions, and Postgres
  // hit "stack depth limit exceeded" (54001) just PARSING the resulting
  // SQL, before it ever touched data. Grouping by level first turns that
  // into a handful of `level = X AND leagueName IN (...)` clauses (at most
  // one per KNOWN_LEVELS entry) instead — an IN list of any size is fine,
  // it's the deeply nested OR tree that Postgres can't parse.
  let podFilter: Record<string, unknown> = {};
  if (pods) {
    const leagueNamesByLevel = new Map<string, Set<string>>();
    for (const p of pods) {
      const set = leagueNamesByLevel.get(p.level) ?? new Set<string>();
      set.add(p.leagueName);
      leagueNamesByLevel.set(p.level, set);
    }
    podFilter = {
      OR: [...leagueNamesByLevel.entries()].map(([level, leagueNames]) => ({
        level,
        leagueName: { in: [...leagueNames] },
      })),
    };
  }

  const teams = await prisma.team.findMany({
    where: {
      seasonSlug,
      status: { not: "draft_pass" },
      ...podFilter,
    },
    select: {
      cardId: true,
      ownerWallet: true,
      level: true,
      leagueId: true,
      leagueName: true,
    },
  });

  // Latest score per team, as a SEPARATE flat query rather than a nested
  // `scores: { orderBy, take: 1 }` relation select on the findMany above.
  // That nested form is what actually caused the "stack depth limit
  // exceeded" (54001) Postgres error on the whole-season /advancement scan
  // (confirmed live 2026-09-15: it still crashed there even after the
  // OR-vs-IN fix above, which only helped the pods-filtered case) —
  // without Prisma's relationJoins preview feature, a "take 1 per parent,
  // ordered" relation select on a findMany with many thousands of parent
  // rows apparently generates SQL Postgres's parser can't handle at that
  // scale. Two flat queries + an in-memory reduction sidesteps that
  // pattern entirely: `teamCardId: { in: [...] }` binds as a single array
  // parameter (cheap regardless of list size, unlike the OR-chain problem
  // above), and picking the first row per teamCardId out of a globally
  // capturedAt-desc-ordered list is equivalent to "latest per team" since
  // the first match per key in a descending scan is always the max.
  const cardIds = teams.map((t) => t.cardId);
  const latestByCard = new Map<string, { weeklyScore: number; seasonScore: number }>();
  if (cardIds.length > 0) {
    const scores = await prisma.scoreSnapshot.findMany({
      where: { seasonSlug, teamCardId: { in: cardIds } },
      orderBy: { capturedAt: "desc" },
      select: { teamCardId: true, weeklyScore: true, seasonScore: true },
    });
    for (const s of scores) {
      if (!latestByCard.has(s.teamCardId)) {
        latestByCard.set(s.teamCardId, { weeklyScore: s.weeklyScore, seasonScore: s.seasonScore });
      }
    }
  }

  const byPod = new Map<string, typeof teams>();
  for (const t of teams) {
    const key = `${t.level}::${t.leagueName}`;
    const arr = byPod.get(key);
    if (arr) arr.push(t);
    else byPod.set(key, [t]);
  }

  const rows: PodRankedTeam[] = [];
  for (const podTeams of byPod.values()) {
    const sorted = [...podTeams].sort(
      (a, b) => (latestByCard.get(b.cardId)?.seasonScore ?? -1) - (latestByCard.get(a.cardId)?.seasonScore ?? -1),
    );
    sorted.forEach((t, i) => {
      const latest = latestByCard.get(t.cardId) ?? null;
      rows.push({
        cardId: t.cardId,
        ownerWallet: t.ownerWallet,
        level: t.level,
        leagueId: t.leagueId,
        leagueName: t.leagueName,
        podRank: latest ? i + 1 : null,
        podSize: sorted.length,
        advancing: !!latest && i < 2,
        weeklyScore: latest?.weeklyScore ?? null,
        seasonScore: latest?.seasonScore ?? null,
      });
    });
  }
  return rows;
}

/** Convenience: index a getPodRanks() result by cardId for merging onto
 * rows from some other query (ScoreSnapshot rows, Sale rows, ...). Only
 * safe within a single season, since cardId is unique per-season only. */
export function podRankByCardId(rows: PodRankedTeam[]): Map<string, PodRankedTeam> {
  return new Map(rows.map((r) => [r.cardId, r]));
}

export interface OwnerAdvancement {
  ownerWallet: string;
  advancing: number;
  /** Teams with a score snapshot (i.e. actually rankable) — the rate's
   * denominator. A team with no score yet counts toward totalTeams but not
   * this, so a wallet that just drafted doesn't get penalized with a 0%. */
  scoredTeams: number;
  totalTeams: number;
  /** advancing / scoredTeams, or null if scoredTeams is 0 (nothing to show
   * a rate for yet). */
  rate: number | null;
}

/** Rolls a getPodRanks() result up by owner wallet. */
export function rollupByOwner(rows: PodRankedTeam[]): OwnerAdvancement[] {
  const byWallet = new Map<string, OwnerAdvancement>();
  for (const r of rows) {
    const entry = byWallet.get(r.ownerWallet) ?? {
      ownerWallet: r.ownerWallet,
      advancing: 0,
      scoredTeams: 0,
      totalTeams: 0,
      rate: null,
    };
    entry.totalTeams++;
    if (r.podRank != null) {
      entry.scoredTeams++;
      if (r.advancing) entry.advancing++;
    }
    byWallet.set(r.ownerWallet, entry);
  }
  for (const entry of byWallet.values()) {
    entry.rate = entry.scoredTeams > 0 ? entry.advancing / entry.scoredTeams : null;
  }
  return [...byWallet.values()];
}

/** "1st" / "2nd" / "3rd" / "4th" / ... */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

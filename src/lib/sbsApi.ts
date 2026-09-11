/**
 * Client for sbsfantasy.com's own public JSON API.
 *
 * This is NOT a documented/official API — it's the same endpoint the
 * sbsfantasy.com frontend calls to render its own leaderboard page, discovered
 * by inspecting network requests. It requires no auth and no API key. Two
 * things to respect if you build on this:
 *
 *   1. It's undocumented, so SBS can change the response shape or block it
 *      at any time without notice. Keep the sync job resilient (log + skip
 *      on failure, don't crash) and re-check field names occasionally.
 *   2. Be a good citizen: this project only reads public leaderboard data
 *      that SBS already shows to anonymous visitors, and the sync script
 *      polls on a schedule (e.g. hourly), not in a tight loop. Don't hammer
 *      it — a few requests every sync run is plenty.
 *
 * CONFIRMED LIMITATION: /api/leaderboard caps out at 500 rows per call and
 * ignores offset/page/cursor params (tested). That means this endpoint gives
 * you the top 500 teams per (level, gameweek) — plenty for leaderboards and
 * pod races, but NOT a full census of all ~14,000 minted teams. For a
 * complete "look up any team" database, pair this with scripts/sync-collection.ts
 * (OpenSea), which can enumerate every token in the collection regardless of
 * score.
 */

const BASE_URL = "https://sbsfantasy.com";

// Values observed in the "All / Pro / HOF / Jackpot / JackHOF" tabs on
// sbsfantasy.com/teams. "all" is what the site itself defaults to; the
// individual level query values are unconfirmed for the API (the UI tabs may
// filter client-side) — sync script defaults to pulling "all" and grouping
// by the `level` field in each returned row instead of relying on a level
// query param.
export const KNOWN_LEVELS = ["Pro", "Hall of Fame", "Jackpot", "JackHOF", "Founder"] as const;
export type SbsLevel = (typeof KNOWN_LEVELS)[number];

export interface SbsLeaderboardRow {
  rank: number;
  username: string;
  teamName: string; // e.g. "BBB #687 · #7304"
  seasonScore: number;
  weeklyScore: number;
  isCurrentUser: boolean;
  ownerWallet: string;
  leagueId: string; // e.g. "2026-fast-draft-606" — the 10-team pod
  leagueName: string; // e.g. "BBB #687"
  cardId: string; // e.g. "7304" — matches the NFT token id
  level: string;
}

export interface SbsUserProfile {
  displayName: string;
  imageUrl: string | null;
  equippedBadge: string | null;
  ripeness: {
    color: string;
    tier: number;
    range: string;
    label: string;
    count: number;
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { accept: "application/json" },
    // Server-side fetch (this runs in the sync script / API routes, never in
    // the browser) so there's no CORS concern — that restriction only
    // applies to client-side fetches from a different origin.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`SBS API ${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Current gameweek key, e.g. "2026REG-01". */
export async function getCurrentGameweek(): Promise<string> {
  const data = await getJson<{ gameweek: string }>("/api/standings?action=gameweek");
  return data.gameweek;
}

/**
 * Top-N leaderboard rows for a gameweek. `limit` is capped server-side at
 * 500 regardless of what you pass.
 */
export async function getLeaderboard(
  gameweek: string,
  orderBy: "SeasonScore" | "WeeklyScore" = "SeasonScore",
): Promise<SbsLeaderboardRow[]> {
  return getJson<SbsLeaderboardRow[]>(
    `/api/leaderboard?gameweek=${encodeURIComponent(gameweek)}&level=all&orderBy=${orderBy}&limit=500`,
  );
}

/** Resolve wallet addresses to display name / avatar / badge in one batch call. */
export async function getUserProfiles(
  wallets: string[],
): Promise<Record<string, SbsUserProfile>> {
  if (wallets.length === 0) return {};
  const res = await fetch(`${BASE_URL}/api/users/display-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ wallets }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`SBS API display-batch -> HTTP ${res.status}`);
  const data = (await res.json()) as { users: Record<string, SbsUserProfile> };
  return data.users;
}

/** Parses "BBB #687 · #7304" into { leaguePrefix: "BBB #687", cardId: "7304" }. */
export function parseTeamName(teamName: string): { leaguePrefix: string; cardId: string | null } {
  const match = teamName.match(/^(.*?)(?:\s*·\s*#(\d+))?$/);
  return {
    leaguePrefix: match?.[1]?.trim() ?? teamName,
    cardId: match?.[2] ?? null,
  };
}

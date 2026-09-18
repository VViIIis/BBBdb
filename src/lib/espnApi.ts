/**
 * Client for ESPN's public, undocumented "site API" for NFL — the same
 * endpoints espn.com's own scoreboard/boxscore pages call client-side.
 * Discovered the same way sbsApi.ts's endpoints were: inspecting real
 * network requests (here, directly against the raw JSON via the browser
 * console) rather than any published API docs. No auth, no API key.
 *
 * Confirmed 2026-09-18 against a real completed game (BUF 41, DET 31,
 * espnEventId 401872932):
 *   - /apis/site/v2/sports/football/nfl/scoreboard — one week's games:
 *     id, date, status, and both competitors' team abbreviation + score.
 *   - /apis/site/v2/sports/football/nfl/summary?event=<id> — full box
 *     score for one game: boxscore.players[teamIdx].statistics[catIdx] is
 *     one stat CATEGORY ("passing" | "rushing" | "receiving" | "fumbles" |
 *     "defensive" | ...) with a fixed `keys` array (column order) and an
 *     `athletes` array of { athlete: {displayName, ...}, stats: string[] }
 *     — stats[i] lines up positionally with keys[i]. boxscore.teams[teamIdx]
 *     .statistics is a flat list of team-level totals (first downs, total
 *     yards, fumblesLost, defensiveTouchdowns, etc). NEITHER of these
 *     exposes a player's POSITION (no "QB"/"WR"/"TE" anywhere on a boxscore
 *     athlete) — that's why getTeamRoster() below exists.
 *   - /apis/site/v2/sports/football/nfl/teams/<abbr>/roster — that team's
 *     current roster, WITH position (athletes[].items[].position.abbreviation).
 *     Used to classify a boxscore player as WR vs TE (RB and QB are inferred
 *     straight from which stat category they appear in — see sbsScoring.ts
 *     — so this is really only needed to split the receiving category).
 *
 * Same undocumented-endpoint caveats as sbsApi.ts: ESPN can change this
 * shape or rate-limit it without notice. Keep sync tolerant (log + skip a
 * bad game rather than crashing the whole run) and don't hammer it — this
 * only ever runs a few times a day (see src/lib/jobs/syncScores.ts).
 */

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

function isRateLimitStatus(status: number) {
  return status === 429;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (isRateLimitStatus(res.status)) {
    throw Object.assign(new Error(`ESPN API ${path} -> HTTP 429 (rate limited)`), { rateLimited: true });
  }
  if (!res.ok) {
    throw new Error(`ESPN API ${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface EspnScoreboardEvent {
  espnEventId: string;
  season: number;
  week: number;
  seasonType: number;
  kickoff: string; // ISO date string, as ESPN returns it
  status: "scheduled" | "in" | "final";
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
}

function mapStatusState(state: string | undefined): EspnScoreboardEvent["status"] {
  // ESPN's own status.type.state values are "pre" | "in" | "post" — collapse
  // to our three-value enum rather than storing ESPN's raw vocabulary.
  if (state === "post") return "final";
  if (state === "in") return "in";
  return "scheduled";
}

/**
 * One week's scoreboard. `week`/`year`/`seasonType` all optional — omitting
 * all three gets ESPN's own idea of "the current week" (handy for a
 * schedule-agnostic default), but the sync job always passes them
 * explicitly so a run is reproducible regardless of what day it runs on.
 * seasonType: 1=preseason, 2=regular, 3=postseason (ESPN's own numbering).
 */
export async function getScoreboard(params?: {
  week?: number;
  year?: number;
  seasonType?: number;
}): Promise<EspnScoreboardEvent[]> {
  const qs = new URLSearchParams();
  if (params?.week) qs.set("week", String(params.week));
  if (params?.year) qs.set("year", String(params.year));
  if (params?.seasonType) qs.set("seasontype", String(params.seasonType));
  const query = qs.toString();
  const data = await getJson<any>(`/scoreboard${query ? `?${query}` : ""}`);

  const events: any[] = data.events ?? [];
  return events.map((ev): EspnScoreboardEvent => {
    const comp = ev.competitions?.[0] ?? {};
    const competitors: any[] = comp.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    return {
      espnEventId: String(ev.id),
      season: ev.season?.year ?? data.season?.year,
      week: ev.week?.number ?? data.week?.number,
      seasonType: ev.season?.type ?? data.season?.type ?? 2,
      kickoff: ev.date,
      status: mapStatusState(comp.status?.type?.state),
      awayTeam: away?.team?.abbreviation ?? "UNK",
      homeTeam: home?.team?.abbreviation ?? "UNK",
      awayScore: away?.score != null ? Number(away.score) : null,
      homeScore: home?.score != null ? Number(home.score) : null,
    };
  });
}

/** One player's stat line within one category, e.g. rushing. `stats` lines
 * up positionally with the category's `keys` (see StatCategory). */
export interface CategoryAthlete {
  displayName: string;
  stats: string[];
}

export interface StatCategory {
  name: string; // "passing" | "rushing" | "receiving" | "fumbles" | "defensive" | ...
  keys: string[]; // column order, e.g. ["rushingAttempts","rushingYards",...]
  athletes: CategoryAthlete[];
}

export interface TeamBoxscore {
  abbreviation: string;
  homeAway: "home" | "away";
  categories: StatCategory[];
  teamStats: Record<string, string>; // flat name -> displayValue, e.g. { fumblesLost: "1", defensiveTouchdowns: "0" }
}

export interface GameBoxscore {
  espnEventId: string;
  completed: boolean;
  teams: TeamBoxscore[]; // always length 2
  scoringPlays: { team: string; typeText: string }[];
}

/** Full box score for one game, reshaped into the flatter form sbsScoring.ts consumes. */
export async function getGameBoxscore(espnEventId: string): Promise<GameBoxscore> {
  const data = await getJson<any>(`/summary?event=${encodeURIComponent(espnEventId)}`);

  const completed = Boolean(data.header?.competitions?.[0]?.status?.type?.completed);

  const rawPlayers: any[] = data.boxscore?.players ?? [];
  const rawTeams: any[] = data.boxscore?.teams ?? [];

  const teams: TeamBoxscore[] = rawTeams.map((t) => {
    const abbr = t.team?.abbreviation ?? "UNK";
    const playersEntry = rawPlayers.find((p) => p.team?.abbreviation === abbr);
    const categories: StatCategory[] = (playersEntry?.statistics ?? []).map((cat: any) => ({
      name: cat.name,
      keys: cat.keys ?? [],
      athletes: (cat.athletes ?? []).map((a: any) => ({
        displayName: a.athlete?.displayName ?? "Unknown",
        stats: a.stats ?? [],
      })),
    }));
    const teamStats: Record<string, string> = {};
    for (const s of t.statistics ?? []) {
      if (s.name) teamStats[s.name] = s.displayValue ?? String(s.value ?? "");
    }
    return { abbreviation: abbr, homeAway: t.homeAway, categories, teamStats };
  });

  const scoringPlays = (data.scoringPlays ?? []).map((sp: any) => ({
    team: sp.team?.abbreviation ?? "UNK",
    typeText: sp.type?.text ?? "",
  }));

  return { espnEventId, completed, teams, scoringPlays };
}

/** lowercased full name -> position abbreviation (e.g. "QB","RB","WR","TE"), offense only. */
export type RosterPositions = Map<string, string>;

/**
 * One team's current roster, position-only lookup. Only the "offense" group
 * is kept — sbsScoring.ts only ever needs this to tell WR from TE (QB/RB are
 * inferred from which boxscore stat category a player appears in), and
 * keeping just offense keeps the map small and the name-collision risk low.
 *
 * `abbr` should be lowercase for this endpoint (ESPN's team-abbreviation
 * path segment is case-sensitive lowercase, unlike the boxscore/scoreboard
 * abbreviations elsewhere in this file, which come back upper case).
 */
export async function getTeamRoster(abbr: string): Promise<RosterPositions> {
  const data = await getJson<any>(`/teams/${abbr.toLowerCase()}/roster`);
  const map: RosterPositions = new Map();
  const groups: any[] = data.athletes ?? [];
  const offense = groups.find((g) => g.position === "offense");
  for (const item of offense?.items ?? []) {
    const name = item.displayName;
    const pos = item.position?.abbreviation;
    if (name && pos) map.set(name.toLowerCase(), pos);
  }
  return map;
}

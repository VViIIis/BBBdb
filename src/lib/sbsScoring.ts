/**
 * SBS Fantasy's "Team Positions" scoring engine — turns one real NFL game's
 * box score (src/lib/espnApi.ts's GameBoxscore) into the 6 SBS slots per
 * team: QB, RB1, RB2, WR1, WR2, TE. Each slot is auto-scored as "the top
 * performer at that stat group for that real team that week" — you draft
 * e.g. "DAL WR1", not a specific player, and whichever Cowboys receiver
 * scores the most that week fills it (see sbsfantasy.com/faq, "Team
 * Positions" + "Scoring" sections, confirmed 2026-09-18). No WR3/RB3 slot:
 * SBS's own starting lineup is 1 QB / 2 RB / 2 WR / 1 TE / 1 Flex / 1 DST —
 * only 2 RB and 2 WR ever start, so this engine only ever produces 2 of
 * each (a 3rd-best WR simply never becomes a scoreable slot).
 *
 * Full PPR scoring, per the FAQ:
 *   Passing:   TD +4, yards +1/25 (continuous), 300+ yd bonus +3, INT -1
 *   Rushing:   TD +6, yards +1/10 (continuous), 100+ yd bonus +3
 *   Receiving: TD +6, yards +1/10 (continuous), 100+ yd bonus +3, catch +1
 *   Fumbles:   lost -1
 *   Defense:   sack +1, INT +2, fumble rec +1, forced fumble +1, safety +2,
 *              defensive/ST TD +6, blocked kick +2, plus a points-allowed
 *              bracket bonus (0=+10, 1-6=+7, 7-13=+4, 14-20=+1, 21-27=0,
 *              28-34=-1, 35+=-4)
 *
 * KNOWN GAPS (ESPN's public boxscore endpoint doesn't expose these at all —
 * see espnApi.ts's docblock): forced fumbles and blocked kicks are NOT
 * counted (both rare, +1/+2 each — a DST total can be a couple points short
 * in a game with one). 2-point conversions are NOT counted (not broken out
 * as their own stat by this endpoint; also rare). Fumble-return TDs ARE
 * covered, folded into the defensive/ST TD count. Document, don't guess —
 * same policy this codebase already uses for other undocumented-API gaps
 * (see sbsApi.ts).
 */
import type { GameBoxscore, RosterPositions, TeamBoxscore } from "./espnApi";

export interface TeamPositionScoreRow {
  team: string;
  slot: "QB" | "RB1" | "RB2" | "WR1" | "WR2" | "TE" | "DST";
  playerName: string | null;
  statLine: string;
  points: number;
}

function statIndex(cat: { keys: string[] } | undefined, key: string): number {
  return cat?.keys.indexOf(key) ?? -1;
}

function num(stats: string[], idx: number): number {
  if (idx < 0) return 0;
  const n = Number(String(stats[idx] ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface PlayerAgg {
  points: number;
  fragments: string[];
  sawPassing: boolean;
  sawRushing: boolean;
  sawReceiving: boolean;
}

function getAgg(map: Map<string, PlayerAgg>, name: string): PlayerAgg {
  let agg = map.get(name);
  if (!agg) {
    agg = { points: 0, fragments: [], sawPassing: false, sawRushing: false, sawReceiving: false };
    map.set(name, agg);
  }
  return agg;
}

/** Builds the per-player point aggregate for one team from its box score categories. */
function aggregateOffense(team: TeamBoxscore): Map<string, PlayerAgg> {
  const players = new Map<string, PlayerAgg>();

  const passing = team.categories.find((c) => c.name === "passing");
  const iYds = statIndex(passing, "passingYards");
  const iTd = statIndex(passing, "passingTouchdowns");
  const iInt = statIndex(passing, "interceptions");
  for (const a of passing?.athletes ?? []) {
    const yds = num(a.stats, iYds);
    const td = num(a.stats, iTd);
    const int = num(a.stats, iInt);
    const pts = td * 4 + yds / 25 + (yds >= 300 ? 3 : 0) - int * 1;
    const agg = getAgg(players, a.displayName);
    agg.points += pts;
    agg.sawPassing = true;
    agg.fragments.push(`${yds} pass yd, ${td} TD${int > 0 ? `, ${int} INT` : ""}`);
  }

  const rushing = team.categories.find((c) => c.name === "rushing");
  const rYds = statIndex(rushing, "rushingYards");
  const rTd = statIndex(rushing, "rushingTouchdowns");
  for (const a of rushing?.athletes ?? []) {
    const yds = num(a.stats, rYds);
    const td = num(a.stats, rTd);
    const pts = td * 6 + yds / 10 + (yds >= 100 ? 3 : 0);
    const agg = getAgg(players, a.displayName);
    agg.points += pts;
    agg.sawRushing = true;
    agg.fragments.push(`${yds} rush yd${td > 0 ? `, ${td} TD` : ""}`);
  }

  const receiving = team.categories.find((c) => c.name === "receiving");
  const cRec = statIndex(receiving, "receptions");
  const cYds = statIndex(receiving, "receivingYards");
  const cTd = statIndex(receiving, "receivingTouchdowns");
  for (const a of receiving?.athletes ?? []) {
    const rec = num(a.stats, cRec);
    const yds = num(a.stats, cYds);
    const td = num(a.stats, cTd);
    const pts = td * 6 + yds / 10 + (yds >= 100 ? 3 : 0) + rec * 1;
    const agg = getAgg(players, a.displayName);
    agg.points += pts;
    agg.sawReceiving = true;
    agg.fragments.push(`${yds} rec yd${td > 0 ? `, ${td} TD` : ""}, ${rec} rec`);
  }

  const fumbles = team.categories.find((c) => c.name === "fumbles");
  const fLost = statIndex(fumbles, "fumblesLost");
  for (const a of fumbles?.athletes ?? []) {
    const lost = num(a.stats, fLost);
    if (lost <= 0) continue;
    // Only ever adjusts an already-touched skill player's total — a lineman
    // fumbling a botched snap has no offensive stat line to begin with and
    // isn't in any position group anyway, so there's nothing to dock.
    if (!players.has(a.displayName)) continue;
    const agg = getAgg(players, a.displayName);
    agg.points -= lost * 1;
    agg.fragments.push(`${lost} fum lost`);
  }

  return players;
}

function classify(name: string, agg: PlayerAgg, roster: RosterPositions | undefined): "QB" | "RB" | "WR" | "TE" {
  if (agg.sawPassing) return "QB";
  const pos = roster?.get(name.toLowerCase());
  if (pos === "TE") return "TE";
  if (pos === "RB" || pos === "FB") return "RB";
  if (pos === "WR") return "WR";
  // Roster lookup miss (name mismatch, practice-squad call-up, etc.) — fall
  // back to which stat category actually carried this player's production.
  if (agg.sawRushing && !agg.sawReceiving) return "RB";
  return "WR";
}

function pointsAllowedBonus(pointsAllowed: number): number {
  if (pointsAllowed === 0) return 10;
  if (pointsAllowed <= 6) return 7;
  if (pointsAllowed <= 13) return 4;
  if (pointsAllowed <= 20) return 1;
  if (pointsAllowed <= 27) return 0;
  if (pointsAllowed <= 34) return -1;
  return -4;
}

function scoreDst(
  team: TeamBoxscore,
  opponent: TeamBoxscore,
  pointsAllowed: number,
  scoringPlays: GameBoxscore["scoringPlays"],
): TeamPositionScoreRow {
  const defensive = team.categories.find((c) => c.name === "defensive");
  const iSacks = statIndex(defensive, "sacks");
  const sacks = (defensive?.athletes ?? []).reduce((sum, a) => sum + num(a.stats, iSacks), 0);

  const oppPassing = opponent.categories.find((c) => c.name === "passing");
  const iOppInt = statIndex(oppPassing, "interceptions");
  const interceptions = (oppPassing?.athletes ?? []).reduce((sum, a) => sum + num(a.stats, iOppInt), 0);

  const fumbleRecoveries = Number(opponent.teamStats.fumblesLost ?? 0) || 0;
  const defensiveTds = Number(team.teamStats.defensiveTouchdowns ?? 0) || 0;
  const safeties = scoringPlays.filter((sp) => sp.team === team.abbreviation && sp.typeText === "Safety").length;

  const points =
    sacks * 1 +
    interceptions * 2 +
    fumbleRecoveries * 1 +
    defensiveTds * 6 +
    safeties * 2 +
    pointsAllowedBonus(pointsAllowed);

  const fragments = [`${sacks} sack${sacks === 1 ? "" : "s"}`];
  if (interceptions > 0) fragments.push(`${interceptions} INT`);
  if (fumbleRecoveries > 0) fragments.push(`${fumbleRecoveries} fum rec`);
  if (defensiveTds > 0) fragments.push(`${defensiveTds} DEF TD`);
  if (safeties > 0) fragments.push(`${safeties} safety`);
  fragments.push(`allowed ${pointsAllowed}`);

  return {
    team: team.abbreviation,
    slot: "DST",
    playerName: `${team.abbreviation} D/ST`,
    statLine: fragments.join(", "),
    points: round2(points),
  };
}

function topSlots(
  team: string,
  group: [string, PlayerAgg][],
  slotNames: TeamPositionScoreRow["slot"][],
): TeamPositionScoreRow[] {
  const sorted = [...group].sort((a, b) => b[1].points - a[1].points);
  return slotNames.map((slot, i) => {
    const entry = sorted[i];
    if (!entry) {
      return { team, slot, playerName: null, statLine: "No qualifying player", points: 0 };
    }
    const [name, agg] = entry;
    return { team, slot, playerName: name, statLine: agg.fragments.join(" · "), points: round2(agg.points) };
  });
}

/**
 * Computes all 14 slots (7 per team: QB/RB1/RB2/WR1/WR2/TE/DST) for one
 * completed game. `rosters` maps each team's abbreviation to its offense
 * position lookup (src/lib/espnApi.ts's getTeamRoster) — used only to split
 * WR from TE, see classify() above.
 */
export function computeTeamPositionScores(
  box: GameBoxscore,
  scores: { awayScore: number; homeScore: number },
  rosters: Record<string, RosterPositions>,
): TeamPositionScoreRow[] {
  const rows: TeamPositionScoreRow[] = [];

  for (const team of box.teams) {
    const opponent = box.teams.find((t) => t !== team)!;
    const pointsAllowed = team.homeAway === "home" ? scores.awayScore : scores.homeScore;

    const players = aggregateOffense(team);
    const roster = rosters[team.abbreviation];

    const rbs: [string, PlayerAgg][] = [];
    const wrs: [string, PlayerAgg][] = [];
    const qbs: [string, PlayerAgg][] = [];
    const tes: [string, PlayerAgg][] = [];
    for (const [name, agg] of players) {
      const group = classify(name, agg, roster);
      if (group === "QB") qbs.push([name, agg]);
      else if (group === "RB") rbs.push([name, agg]);
      else if (group === "TE") tes.push([name, agg]);
      else wrs.push([name, agg]);
    }

    rows.push(...topSlots(team.abbreviation, qbs, ["QB"]));
    rows.push(...topSlots(team.abbreviation, rbs, ["RB1", "RB2"]));
    rows.push(...topSlots(team.abbreviation, wrs, ["WR1", "WR2"]));
    rows.push(...topSlots(team.abbreviation, tes, ["TE"]));
    rows.push(scoreDst(team, opponent, pointsAllowed, box.scoringPlays));
  }

  return rows;
}

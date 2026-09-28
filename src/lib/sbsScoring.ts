/**
 * SBS Fantasy's "Team Positions" scoring engine — turns one real NFL game's
 * box score (src/lib/espnApi.ts's GameBoxscore) into the 7 SBS slots per
 * team: QB, RB1, RB2, WR1, WR2, TE, DST. Each slot is auto-scored as "the top
 * performer at that position for that real team that week" — you draft
 * e.g. "DAL WR1", not a specific player, and whichever Cowboys receiver
 * scores the most that week fills it (see sbsfantasy.com/faq, "Team
 * Positions" + "Scoring" sections, confirmed 2026-09-18). No WR3/RB3 slot.
 *
 * Full PPR scoring, per the FAQ:
 *   Passing:   TD +4, yards +1/25 (continuous), 300+ yd bonus +3, INT -1
 *   Rushing:   TD +6, yards +1/10 (continuous), 100+ yd bonus +3
 *   Receiving: TD +6, yards +1/10 (continuous), 100+ yd bonus +3, catch +1
 *   2-pt conversions: +2 to the passer AND the receiver, or the runner
 *   Fumbles:   lost -1
 *   Defense:   sack +1, INT +2, fumble rec +1, forced fumble +1, safety +2,
 *              defensive/ST TD +6, blocked kick +2, plus a points-allowed
 *              bracket bonus (0=+10, 1-6=+7, 7-13=+4, 14-20=+1, 21-27=0,
 *              28-34=-1, 35+=-4)
 *
 * A player's points count ALL of his stats, but he only competes for his
 * ROSTER position's slots. So a receiver who throws a trick-play pass keeps
 * those passing points in his WR total and is never a candidate for the QB
 * slot. (Before 2026-09-28 anyone with a passing line was treated as a QB:
 * Jaxon Smith-Njigba's one completion in week 3 put his whole WR game in the
 * SEA QB slot and knocked him out of WR1.)
 *
 * CHECKED AGAINST SBS, 2026-09-28: SBS's standings API reports its own
 * per-slot weekly score for every team position. Weeks 1-3 of 2026: 506 of
 * 508 offensive slots and 91 of 94 D/ST slots match SBS to the hundredth.
 * The few left are 1-2 point stat disagreements between ESPN and SBS's data
 * source, not scoring-rule differences.
 */
import type { GameBoxscore, RosterPositions, TeamBoxscore, TeamDefenseExtras } from "./espnApi";

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
  id: string;
  name: string;
  points: number;
  fragments: string[];
  passAttempts: number;
  sawPassing: boolean;
  sawRushing: boolean;
  sawReceiving: boolean;
}

class PlayerTable {
  private byKey = new Map<string, PlayerAgg>();

  /** Keyed by ESPN athlete id when there is one, so two players with the same name never merge. */
  get(id: string, name: string): PlayerAgg {
    const key = id ? `id:${id}` : `name:${name.toLowerCase()}`;
    let agg = this.byKey.get(key);
    if (!agg) {
      agg = { id, name, points: 0, fragments: [], passAttempts: 0, sawPassing: false, sawRushing: false, sawReceiving: false };
      this.byKey.set(key, agg);
    }
    return agg;
  }

  has(id: string, name: string): boolean {
    return this.byKey.has(id ? `id:${id}` : `name:${name.toLowerCase()}`);
  }

  /** For 2-pt conversions, which only come as scoring-play text (names, no ids). */
  getByName(name: string): PlayerAgg {
    const lower = name.toLowerCase();
    for (const agg of this.byKey.values()) if (agg.name.toLowerCase() === lower) return agg;
    return this.get("", name);
  }

  values(): PlayerAgg[] {
    return [...this.byKey.values()];
  }
}

/**
 * Successful 2-point conversions for one team, from ESPN's scoring-play text,
 * e.g. "Jake Ferguson 19 Yd pass from Dak Prescott (Dak Prescott Pass to
 * CeeDee Lamb for Two-Point Conversion)" or "(Travis Etienne Jr. Run for
 * Two-Point Conversion)". Failed tries read "... Conversion Failed)" and
 * don't match. ESPN has no 2-pt stat column, so the text is the only source.
 * Every 2-pt play in weeks 1-3 of 2026 used one of these two forms.
 */
function twoPointConversions(team: string, plays: GameBoxscore["scoringPlays"]): { passer?: string; player: string }[] {
  const out: { passer?: string; player: string }[] = [];
  for (const sp of plays) {
    if (sp.team !== team) continue;
    const pass = sp.text.match(/\(([^()]+?) Pass to ([^()]+?) for Two-Point Conversion\)/i);
    if (pass) {
      out.push({ passer: pass[1].trim(), player: pass[2].trim() });
      continue;
    }
    const run = sp.text.match(/\(([^()]+?) Run for Two-Point Conversion\)/i);
    if (run) out.push({ player: run[1].trim() });
  }
  return out;
}

/** Builds the per-player point aggregate for one team from its box score categories. */
function aggregateOffense(team: TeamBoxscore, scoringPlays: GameBoxscore["scoringPlays"]): PlayerAgg[] {
  const players = new PlayerTable();

  const passing = team.categories.find((c) => c.name === "passing");
  const iYds = statIndex(passing, "passingYards");
  const iTd = statIndex(passing, "passingTouchdowns");
  const iInt = statIndex(passing, "interceptions");
  const iCompAtt = statIndex(passing, "completions/passingAttempts");
  for (const a of passing?.athletes ?? []) {
    const yds = num(a.stats, iYds);
    const td = num(a.stats, iTd);
    const int = num(a.stats, iInt);
    const att = Number(String(a.stats[iCompAtt] ?? "").split("/")[1]) || 0;
    const agg = players.get(a.id, a.displayName);
    agg.points += td * 4 + yds / 25 + (yds >= 300 ? 3 : 0) - int * 1;
    agg.passAttempts += att;
    agg.sawPassing = true;
    agg.fragments.push(`${yds} pass yd, ${td} TD${int > 0 ? `, ${int} INT` : ""}`);
  }

  const rushing = team.categories.find((c) => c.name === "rushing");
  const rYds = statIndex(rushing, "rushingYards");
  const rTd = statIndex(rushing, "rushingTouchdowns");
  for (const a of rushing?.athletes ?? []) {
    const yds = num(a.stats, rYds);
    const td = num(a.stats, rTd);
    const agg = players.get(a.id, a.displayName);
    agg.points += td * 6 + yds / 10 + (yds >= 100 ? 3 : 0);
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
    const agg = players.get(a.id, a.displayName);
    agg.points += td * 6 + yds / 10 + (yds >= 100 ? 3 : 0) + rec * 1;
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
    if (!players.has(a.id, a.displayName)) continue;
    const agg = players.get(a.id, a.displayName);
    agg.points -= lost * 1;
    agg.fragments.push(`${lost} fum lost`);
  }

  for (const conv of twoPointConversions(team.abbreviation, scoringPlays)) {
    if (conv.passer) {
      const passer = players.getByName(conv.passer);
      passer.points += 2;
      passer.fragments.push("2-pt pass");
    }
    const player = players.getByName(conv.player);
    player.points += 2;
    player.fragments.push("2-pt conv");
  }

  return players.values();
}

/**
 * Which slot group a player competes in: his ROSTER position (see the
 * docblock at the top). Only when ESPN's roster doesn't have him at all (very
 * rare now that every roster group is loaded) does this fall back to his
 * stats: a real passing workload (5+ attempts) = QB, rushing without catches
 * = RB, anything else = WR.
 */
function classify(agg: PlayerAgg, roster: RosterPositions | undefined): "QB" | "RB" | "WR" | "TE" | null {
  const pos = (agg.id && roster?.byId.get(agg.id)) || roster?.byName.get(agg.name.toLowerCase());
  if (pos === "QB") return "QB";
  if (pos === "TE") return "TE";
  if (pos === "RB" || pos === "FB") return "RB";
  if (pos === "WR") return "WR";
  if (pos) return null; // a defender or specialist with an offensive stat (fake punt etc.) — no offensive slot
  if (agg.sawPassing && agg.passAttempts >= 5) return "QB";
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
  extras: TeamDefenseExtras | undefined,
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
  const forcedFumbles = extras?.fumblesForced ?? 0;
  const blockedKicks = extras?.kicksBlocked ?? 0;
  const returnTds = extras?.returnTouchdowns ?? 0;

  const points =
    sacks * 1 +
    interceptions * 2 +
    fumbleRecoveries * 1 +
    forcedFumbles * 1 +
    blockedKicks * 2 +
    (defensiveTds + returnTds) * 6 +
    safeties * 2 +
    pointsAllowedBonus(pointsAllowed);

  const fragments = [`${sacks} sack${sacks === 1 ? "" : "s"}`];
  if (interceptions > 0) fragments.push(`${interceptions} INT`);
  if (forcedFumbles > 0) fragments.push(`${forcedFumbles} FF`);
  if (fumbleRecoveries > 0) fragments.push(`${fumbleRecoveries} fum rec`);
  if (blockedKicks > 0) fragments.push(`${blockedKicks} blocked kick${blockedKicks === 1 ? "" : "s"}`);
  if (defensiveTds > 0) fragments.push(`${defensiveTds} DEF TD`);
  if (returnTds > 0) fragments.push(`${returnTds} return TD`);
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

function topSlots(team: string, group: PlayerAgg[], slotNames: TeamPositionScoreRow["slot"][]): TeamPositionScoreRow[] {
  const sorted = [...group].sort((a, b) => b.points - a.points);
  return slotNames.map((slot, i) => {
    const agg = sorted[i];
    if (!agg) return { team, slot, playerName: null, statLine: "No qualifying player", points: 0 };
    return { team, slot, playerName: agg.name, statLine: agg.fragments.join(" · "), points: round2(agg.points) };
  });
}

/**
 * Computes all 14 slots (7 per team: QB/RB1/RB2/WR1/WR2/TE/DST) for one
 * completed game. `rosters` maps each team's abbreviation to its roster
 * positions (espnApi.ts's getTeamRoster); `defenseExtras` maps it to the
 * core-API D/ST stats (getTeamDefenseExtras) — if those couldn't be fetched,
 * D/ST is scored without forced fumbles, blocked kicks and return TDs.
 */
export function computeTeamPositionScores(
  box: GameBoxscore,
  scores: { awayScore: number; homeScore: number },
  rosters: Record<string, RosterPositions>,
  defenseExtras: Record<string, TeamDefenseExtras | undefined> = {},
): TeamPositionScoreRow[] {
  const rows: TeamPositionScoreRow[] = [];

  for (const team of box.teams) {
    const opponent = box.teams.find((t) => t !== team)!;
    const pointsAllowed = team.homeAway === "home" ? scores.awayScore : scores.homeScore;
    const roster = rosters[team.abbreviation];

    const groups: Record<"QB" | "RB" | "WR" | "TE", PlayerAgg[]> = { QB: [], RB: [], WR: [], TE: [] };
    for (const agg of aggregateOffense(team, box.scoringPlays)) {
      const group = classify(agg, roster);
      if (group) groups[group].push(agg);
    }

    rows.push(...topSlots(team.abbreviation, groups.QB, ["QB"]));
    rows.push(...topSlots(team.abbreviation, groups.RB, ["RB1", "RB2"]));
    rows.push(...topSlots(team.abbreviation, groups.WR, ["WR1", "WR2"]));
    rows.push(...topSlots(team.abbreviation, groups.TE, ["TE"]));
    rows.push(scoreDst(team, opponent, pointsAllowed, box.scoringPlays, defenseExtras[team.abbreviation]));
  }

  return rows;
}

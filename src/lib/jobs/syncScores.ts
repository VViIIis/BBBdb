import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import {
  getScoreboard,
  getGameBoxscore,
  getTeamDefenseExtras,
  getTeamRoster,
  RosterPositions,
  EspnScoreboardEvent,
  TeamDefenseExtras,
} from "@/lib/espnApi";
import { computeTeamPositionScores } from "@/lib/sbsScoring";

function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

// Same rateLimited-flagged-error + backoff convention as syncStandings.ts /
// syncSbsTrades.ts.
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.rateLimited && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Powers the /scores tab: SBS-format "Team Positions" box score cards for
 * every real NFL game, every week — Jack's call (over just primetime games)
 * when this was scoped, per the AskUserQuestion answers on 2026-09-18.
 *
 * FINAL BOX SCORES ONLY, by design — also Jack's call in that same scoping
 * round, over a true live in-game feed. A game's TeamPositionScore rows are
 * only ever computed once ESPN marks it "final"; a scheduled/in-progress
 * game still gets an NflGame row (so the /scores week view can show it as
 * upcoming/in progress) but no slot rows until it's done. This keeps the
 * job a simple periodic poll (a few times a day is plenty — see
 * .github/workflows/sync-scores.yml) instead of a tight in-game loop, and
 * avoids ever showing a stat line that could still change mid-game.
 *
 * Scans the CURRENT week plus the PREVIOUS week every run (not just
 * current) so a Monday/late game that finishes after that day's last run,
 * or a run that gets skipped entirely, still gets picked up on the next
 * one — same "tolerant, self-healing" idea as this codebase's other sync
 * jobs, just windowed by week instead of by draft-id range.
 *
 * Every final game in that window is RE-scored on every run, not just
 * newly-final ones (changed 2026-09-28). The NFL issues stat corrections
 * for days after a game, and a fix to the scoring rules should reach games
 * already scored. That's at most ~32 box scores per run, which is fine
 * every 3 hours.
 *
 * To re-score older weeks once (e.g. after a scoring fix), set SCORES_WEEKS:
 *   SCORES_WEEKS=1-3 npm run sync:scores      (or "1,2,3")
 *
 * Regular season only (seasonType=2) for now — postseason has its own
 * quirks (byes, single-elim, a champ week) not worth the edge cases until
 * someone actually asks for playoff box scores.
 */
export async function runSyncScores() {
  const syncLogRow = await prisma.syncLog.create({ data: { source: "nfl-scores" } });

  try {
    // No params = ESPN's own idea of "the current week" — used only to
    // learn where "current" is; the actual events come from explicit
    // per-week calls below so the result is reproducible regardless of
    // what day this runs.
    const current = await withRetry(() => getScoreboard());
    const currentWeek = current[0]?.week;
    const currentSeason = current[0]?.season;
    if (!currentWeek || !currentSeason) {
      throw new Error("Could not determine current NFL week from ESPN scoreboard — empty/unexpected response");
    }

    const targetWeeks = parseWeeksOverride(process.env.SCORES_WEEKS, currentSeason) ?? [
      { season: currentSeason, week: currentWeek },
      ...(currentWeek > 1 ? [{ season: currentSeason, week: currentWeek - 1 }] : []),
    ];
    log(`[sync-scores] target weeks: ${targetWeeks.map((w) => `${w.season} wk${w.week}`).join(", ")}`);

    const allEvents: EspnScoreboardEvent[] = [];
    for (const w of targetWeeks) {
      const events = await withRetry(() => getScoreboard({ year: w.season, week: w.week, seasonType: 2 }));
      allEvents.push(...events);
    }
    log(`[sync-scores] ${allEvents.length} games across ${targetWeeks.length} week(s)`);

    // Upsert every game's shell (score/status/kickoff) regardless of
    // status, so the week view always has a complete slate.
    for (const ev of allEvents) {
      await prisma.nflGame.upsert({
        where: { espnEventId: ev.espnEventId },
        create: {
          espnEventId: ev.espnEventId,
          season: ev.season,
          week: ev.week,
          seasonType: ev.seasonType,
          kickoff: new Date(ev.kickoff),
          awayTeam: ev.awayTeam,
          homeTeam: ev.homeTeam,
          awayScore: ev.awayScore,
          homeScore: ev.homeScore,
          status: ev.status,
        },
        update: {
          awayScore: ev.awayScore,
          homeScore: ev.homeScore,
          status: ev.status,
        },
      });
    }

    const needsScoring = allEvents.filter((ev) => ev.status === "final");
    log(`[sync-scores] scoring ${needsScoring.length} final game(s)`);

    const rosterCache = new Map<string, RosterPositions>();
    async function rosterFor(abbr: string): Promise<RosterPositions> {
      const cached = rosterCache.get(abbr);
      if (cached) return cached;
      const roster = await withRetry(() => getTeamRoster(abbr));
      rosterCache.set(abbr, roster);
      return roster;
    }

    // Forced fumbles / blocked kicks / return TDs for D/ST come from a
    // second ESPN API (see getTeamDefenseExtras). Non-fatal: if it fails,
    // that team's D/ST is scored without them rather than failing the game.
    async function extrasFor(eventId: string, teamId: string, abbr: string): Promise<TeamDefenseExtras | undefined> {
      if (!teamId) return undefined;
      try {
        return await withRetry(() => getTeamDefenseExtras(eventId, teamId));
      } catch (err) {
        log(`[sync-scores] D/ST extras for ${abbr} in game ${eventId} unavailable, scoring without them: ${String(err)}`);
        return undefined;
      }
    }

    // Small concurrency: at most ~32 games in scope — gentle enough not to
    // need syncStandings.ts-style batch tuning.
    const CONCURRENCY = Number(process.env.SCORES_SYNC_CONCURRENCY ?? 3);
    let scored = 0;
    let failed = 0;
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < needsScoring.length) {
        const ev = needsScoring[nextIdx++];
        try {
          const box = await withRetry(() => getGameBoxscore(ev.espnEventId));
          const [awayRoster, homeRoster] = await Promise.all([rosterFor(ev.awayTeam), rosterFor(ev.homeTeam)]);
          const defenseExtras: Record<string, TeamDefenseExtras | undefined> = {};
          await Promise.all(
            box.teams.map(async (t) => {
              defenseExtras[t.abbreviation] = await extrasFor(ev.espnEventId, t.espnTeamId, t.abbreviation);
            }),
          );
          const rows = computeTeamPositionScores(
            box,
            { awayScore: ev.awayScore ?? 0, homeScore: ev.homeScore ?? 0 },
            { [ev.awayTeam]: awayRoster, [ev.homeTeam]: homeRoster },
            defenseExtras,
          );
          for (const row of rows) {
            await prisma.teamPositionScore.upsert({
              where: { gameId_team_slot: { gameId: ev.espnEventId, team: row.team, slot: row.slot } },
              create: {
                gameId: ev.espnEventId,
                team: row.team,
                slot: row.slot,
                playerName: row.playerName,
                statLine: row.statLine,
                points: row.points,
              },
              update: {
                playerName: row.playerName,
                statLine: row.statLine,
                points: row.points,
              },
            });
          }
          scored++;
        } catch (err) {
          failed++;
          log(`[sync-scores] game ${ev.espnEventId} (${ev.awayTeam} @ ${ev.homeTeam}) failed: ${String(err)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    log(`[sync-scores] done: ${allEvents.length} games synced, ${scored} scored, ${failed} failed`);
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), recordCount: scored, ok: true },
    });
    return { games: allEvents.length, scored, failed };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

/** "1-3" or "1,2,3" -> those weeks of `season`; undefined/blank -> null (use the default window). */
function parseWeeksOverride(value: string | undefined, season: number): { season: number; week: number }[] | null {
  if (!value || !value.trim()) return null;
  const weeks = new Set<number>();
  for (const part of value.split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    if (!Number.isInteger(a)) throw new Error(`SCORES_WEEKS: can't read "${part}" (use e.g. "1-3" or "1,2,3")`);
    const end = Number.isInteger(b) ? b : a;
    for (let w = a; w <= end; w++) weeks.add(w);
  }
  return [...weeks].sort((x, y) => x - y).map((week) => ({ season, week }));
}

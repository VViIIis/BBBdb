import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import { getScoreboard, getGameBoxscore, getTeamRoster, RosterPositions, EspnScoreboardEvent } from "@/lib/espnApi";
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
 * jobs, just windowed by week instead of by draft-id range. A game whose
 * NflGame.status is ALREADY "final" from a prior run is skipped (no
 * re-fetch of its box score / no re-score) — final results don't change,
 * so there's nothing to gain from re-summarizing a game we've already
 * scored, and skipping keeps this job cheap even at "every game" scope.
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

    const targetWeeks = [{ season: currentSeason, week: currentWeek }];
    if (currentWeek > 1) targetWeeks.push({ season: currentSeason, week: currentWeek - 1 });
    log(`[sync-scores] target weeks: ${targetWeeks.map((w) => `${w.season} wk${w.week}`).join(", ")}`);

    const allEvents: EspnScoreboardEvent[] = [];
    for (const w of targetWeeks) {
      const events = await withRetry(() => getScoreboard({ year: w.season, week: w.week, seasonType: 2 }));
      allEvents.push(...events);
    }
    log(`[sync-scores] ${allEvents.length} games across ${targetWeeks.length} week(s)`);

    const existing = await prisma.nflGame.findMany({
      where: { espnEventId: { in: allEvents.map((e) => e.espnEventId) } },
      select: { espnEventId: true, status: true },
    });
    const existingStatus = new Map(existing.map((e) => [e.espnEventId, e.status]));

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

    const needsScoring = allEvents.filter((ev) => ev.status === "final" && existingStatus.get(ev.espnEventId) !== "final");
    log(`[sync-scores] ${needsScoring.length} newly-final game(s) need box-score scoring`);

    const rosterCache = new Map<string, RosterPositions>();
    async function rosterFor(abbr: string): Promise<RosterPositions> {
      const cached = rosterCache.get(abbr);
      if (cached) return cached;
      const roster = await withRetry(() => getTeamRoster(abbr));
      rosterCache.set(abbr, roster);
      return roster;
    }

    // Small concurrency: at most ~32 games in scope, and only "newly
    // final" ones ever reach this loop — gentle enough not to need
    // syncStandings.ts-style batch tuning.
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
          const rows = computeTeamPositionScores(
            box,
            { awayScore: ev.awayScore ?? 0, homeScore: ev.homeScore ?? 0 },
            { [ev.awayTeam]: awayRoster, [ev.homeTeam]: homeRoster },
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

    log(`[sync-scores] done: ${allEvents.length} games synced, ${scored} newly scored, ${failed} failed`);
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

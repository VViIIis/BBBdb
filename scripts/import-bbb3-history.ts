/**
 * Rebuilds Banana Best Ball III's full week-by-week scoring history, weeks
 * 1-17, including the Week 17 finals. Run with `npm run import:bbb3-history`.
 *
 * Why this exists: scripts/import-season.ts only had OpenSea's frozen NFT
 * traits to work with, so BBB III got ONE "bbb3-final" snapshot per team and
 * no weekly history. BBB III still has its own live site at
 * draft.sbsfantasy.com (the leaderboard SBS screenshotted for the
 * "Congrats to @VViIIis" tweet), and that site reads from a separate backend
 * with the full history. Endpoints below were found in draft.sbsfantasy.com's
 * own JS bundle and confirmed live on 2026-09-25, no auth needed:
 *
 *   GET {API}/league/all/null/draftTokenLeaderboard/gameweek/2025REG-XX/orderBy/ScoreWeek/level/{Pro|Hall of Fame|Jackpot}
 *     -> {leaderboard: [...]} with EVERY team at that level for that week
 *        (week 3 Pro alone is 11,848 teams / ~45 MB). Each entry has
 *        scoreWeek / scoreSeason for THAT week, ownerId, level, per-slot
 *        roster scoring, a pfp {displayName, imageUrl}, and card._leagueId
 *        = the league the team ENDED the season in (e.g.
 *        "2025-playoffs-finals"), not the league it was in that week.
 *   GET {API}/league/null/drafts/2025-playoffs-finals/leaderboard/ScoreWeek/gameweek/2025REG-17
 *     -> the finals league on its own (115 teams). Matches the tweet exactly:
 *        #1146 VViIIis 209.72, #2561 Hammer32 207.72, #1865 HasThreeKids
 *        206.12, ... Not called here — the level pulls above already
 *        include every finals team — but handy for spot checks.
 *
 * Scoring note: weeks 15-17 are the playoffs, and SBS resets season score
 * when they start (e.g. #1146's week 17 season score is 626.22 = weeks
 * 15+16+17 only). Stored exactly as SBS reports it. src/lib/advancement.ts
 * ignores weeks 15-17 when ranking pods, so this doesn't scramble the
 * week 1-14 pod standings.
 *
 * What it writes (all scoped to seasonSlug "bbb3"):
 *   - One ScoreSnapshot per team per week, gameweek "2025REG-01".."2025REG-17",
 *     capturedAt set to the Tuesday after that NFL week so "latest snapshot"
 *     logic elsewhere picks each team's last played week. Each week is
 *     replaced wholesale (delete + bulk insert), so re-running is safe.
 *   - Team.status "finals" for the 115 finals teams (the site's Finals
 *     leaderboard reads this) and "advanced" for teams that reached a
 *     playoff round or the Hall of Fame sprint but not the finals.
 *   - Owner display name / avatar from BBB III profiles, ONLY where we don't
 *     already have one (never overwrites BBB IV profile data).
 *   - Deletes the old "bbb3-final" snapshot for any team that now has real
 *     weekly history (it's the same final state, just without the weeks).
 *
 * Writes use bulk createMany (1,000 rows per insert) rather than per-row
 * upserts: ~190k rows at sync-standings' per-row pace would take hours and
 * lean hard on the Supabase free tier.
 */
import { writeSync } from "fs";
import { prisma } from "../src/lib/db";

const SEASON_SLUG = "bbb3";
const API = "https://sbs-drafts-api-w5wydprnbq-uc.a.run.app";
const YEAR = 2025;
const WEEKS = 17;
const LEVELS = ["Pro", "Hall of Fame", "Jackpot"];
const FINALS_LEAGUE_ID = "2025-playoffs-finals";
const INSERT_CHUNK = 1000;

function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

function gameweekFor(week: number) {
  return `${YEAR}REG-${String(week).padStart(2, "0")}`;
}

// 2025 NFL week 1 ran Thu Sep 4 - Mon Sep 8, so week N wraps up by the
// Tuesday 7*(N-1) days after Sep 9. Week 17 -> Tue Dec 30, the day after
// SBS's winner tweet.
function capturedAtFor(week: number) {
  return new Date(Date.UTC(YEAR, 8, 9 + 7 * (week - 1), 12));
}

interface Entry {
  cardId: string;
  ownerWallet: string;
  level: string;
  finalLeagueId: string;
  finalLeagueName: string;
  weeklyScore: number;
  seasonScore: number;
  pfpName: string | null;
  pfpImage: string | null;
}

async function fetchJson(url: string, attempts = 5): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= attempts) throw new Error(`${url} failed after ${attempts} attempts: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function fetchWeek(week: number): Promise<Map<string, Entry>> {
  const gameweek = gameweekFor(week);
  const byCard = new Map<string, Entry>();
  for (const level of LEVELS) {
    const url = `${API}/league/all/null/draftTokenLeaderboard/gameweek/${gameweek}/orderBy/ScoreWeek/level/${encodeURIComponent(level)}`;
    const data = await fetchJson(url);
    const entries: any[] = data?.leaderboard ?? [];
    for (const e of entries) {
      const cardId = String(e?.card?.realTokenId ?? e?._cardId ?? e?.card?._cardId ?? "");
      const ownerWallet = String(e?.ownerId ?? e?.card?._ownerId ?? "").toLowerCase();
      const weeklyScore = Number(e?.scoreWeek);
      const seasonScore = Number(e?.scoreSeason);
      if (!/^\d+$/.test(cardId) || !ownerWallet.startsWith("0x")) continue;
      if (!Number.isFinite(weeklyScore) || !Number.isFinite(seasonScore)) continue;
      // The same team can come back under more than one level query in the
      // playoff weeks (e.g. week 15's "Pro" pull also returns HOF and
      // Jackpot teams). Keep the first — the scores are identical.
      if (byCard.has(cardId)) continue;
      byCard.set(cardId, {
        cardId,
        ownerWallet,
        level: String(e?.level ?? e?.card?._level ?? level),
        finalLeagueId: String(e?.card?._leagueId ?? ""),
        finalLeagueName: String(e?.card?._leagueDisplayName ?? e?.card?._leagueId ?? ""),
        weeklyScore: Math.round(weeklyScore * 100) / 100,
        seasonScore: Math.round(seasonScore * 100) / 100,
        pfpName: e?.pfp?.displayName ? String(e.pfp.displayName) : null,
        pfpImage: e?.pfp?.imageUrl ? String(e.pfp.imageUrl) : null,
      });
    }
    log(`  ${gameweek} ${level}: ${entries.length} entries`);
  }
  return byCard;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const season = await prisma.season.findUnique({ where: { slug: SEASON_SLUG } });
  if (!season) throw new Error(`Season "${SEASON_SLUG}" not found — run scripts/import-season.ts first.`);

  // 1. Fetch every week BEFORE writing anything, so a network failure
  // halfway through leaves the DB untouched rather than half-rebuilt.
  log(`[bbb3-history] fetching ${WEEKS} weeks from draft.sbsfantasy.com's backend...`);
  const weeks: { week: number; gameweek: string; entries: Map<string, Entry> }[] = [];
  for (let week = 1; week <= WEEKS; week++) {
    const entries = await fetchWeek(week);
    weeks.push({ week, gameweek: gameweekFor(week), entries });
    log(`[bbb3-history] ${gameweekFor(week)}: ${entries.size} teams`);
  }
  if (weeks[0].entries.size < 10000) {
    throw new Error(`Week 1 only returned ${weeks[0].entries.size} teams (expected ~12,700) — aborting before writing anything.`);
  }

  // Latest-known info per card (owner, final league, profile) across all weeks.
  const latestByCard = new Map<string, Entry>();
  for (const w of weeks) for (const e of w.entries.values()) latestByCard.set(e.cardId, e);
  log(`[bbb3-history] ${latestByCard.size} distinct teams across the season`);

  // 2. Owners: make sure every wallet exists, then fill in a name/avatar
  // only where we don't have one yet.
  const wallets = [...new Set([...latestByCard.values()].map((e) => e.ownerWallet))];
  for (const part of chunk(wallets, INSERT_CHUNK)) {
    await prisma.owner.createMany({ data: part.map((wallet) => ({ wallet })), skipDuplicates: true });
  }
  const profileByWallet = new Map<string, { name: string | null; image: string | null }>();
  for (const e of latestByCard.values()) {
    if (e.pfpName && !profileByWallet.has(e.ownerWallet)) {
      profileByWallet.set(e.ownerWallet, { name: e.pfpName, image: e.pfpImage });
    }
  }
  const unnamed = new Set<string>();
  for (const part of chunk(wallets, 5000)) {
    const rows = await prisma.owner.findMany({
      where: { wallet: { in: part }, displayName: null },
      select: { wallet: true },
    });
    for (const r of rows) unnamed.add(r.wallet);
  }
  const toName = [...unnamed].filter((w) => profileByWallet.has(w));
  for (const part of chunk(toName, 10)) {
    await Promise.all(
      part.map((wallet) => {
        const p = profileByWallet.get(wallet)!;
        return prisma.owner.updateMany({
          where: { wallet, displayName: null },
          data: { displayName: p.name, ...(p.image ? { imageUrl: p.image } : {}) },
        });
      }),
    );
  }
  log(`[bbb3-history] owners: ${wallets.length} total, filled in ${toName.length} missing names/avatars`);

  // 3. Teams: create any that import-season.ts never saw. Existing rows are
  // left alone — their leagueName ("BBB #N", from OpenSea) is the week 1-14
  // pod, which is what pod pages group by.
  const existing = new Set<string>();
  const allCardIds = [...latestByCard.keys()];
  for (const part of chunk(allCardIds, 5000)) {
    const rows = await prisma.team.findMany({
      where: { seasonSlug: SEASON_SLUG, cardId: { in: part } },
      select: { cardId: true },
    });
    for (const r of rows) existing.add(r.cardId);
  }
  const missing = allCardIds.filter((id) => !existing.has(id)).map((id) => latestByCard.get(id)!);
  for (const part of chunk(missing, INSERT_CHUNK)) {
    await prisma.team.createMany({
      data: part.map((e) => ({
        cardId: e.cardId,
        seasonSlug: SEASON_SLUG,
        leagueId: e.finalLeagueId || `bbb3-${e.cardId}`,
        leagueName: e.finalLeagueName || `Team #${e.cardId}`,
        level: e.level,
        ownerWallet: e.ownerWallet,
      })),
      skipDuplicates: true,
    });
  }
  log(`[bbb3-history] teams: ${existing.size} already existed, created ${missing.length}`);

  // 4. Playoff status. card._leagueId is where each team finished.
  const finalsIds = allCardIds.filter((id) => latestByCard.get(id)!.finalLeagueId === FINALS_LEAGUE_ID);
  const advancedIds = allCardIds.filter((id) => {
    const lg = latestByCard.get(id)!.finalLeagueId;
    return lg !== FINALS_LEAGUE_ID && (lg.startsWith("2025-playoffs-") || lg === "2025-hall-of-fame-sprint");
  });
  for (const part of chunk(finalsIds, 5000)) {
    await prisma.team.updateMany({
      where: { seasonSlug: SEASON_SLUG, cardId: { in: part }, status: { not: "draft_pass" } },
      data: { status: "finals" },
    });
  }
  for (const part of chunk(advancedIds, 5000)) {
    await prisma.team.updateMany({
      where: { seasonSlug: SEASON_SLUG, cardId: { in: part }, status: { not: "draft_pass" } },
      data: { status: "advanced" },
    });
  }
  log(`[bbb3-history] status: ${finalsIds.length} finals teams, ${advancedIds.length} other playoff teams`);

  // 5. Weekly snapshots, one week at a time: clear the week, bulk insert.
  // rank = position by season score that week, across every level.
  for (const w of weeks) {
    const rows = [...w.entries.values()].sort((a, b) => b.seasonScore - a.seasonScore);
    const capturedAt = capturedAtFor(w.week);
    await prisma.scoreSnapshot.deleteMany({ where: { seasonSlug: SEASON_SLUG, gameweek: w.gameweek } });
    let inserted = 0;
    for (const part of chunk(rows, INSERT_CHUNK)) {
      await prisma.scoreSnapshot.createMany({
        data: part.map((e, i) => ({
          seasonSlug: SEASON_SLUG,
          teamCardId: e.cardId,
          gameweek: w.gameweek,
          rank: inserted + i + 1,
          weeklyScore: e.weeklyScore,
          seasonScore: e.seasonScore,
          capturedAt,
        })),
        skipDuplicates: true,
      });
      inserted += part.length;
    }
    log(`[bbb3-history] wrote ${w.gameweek}: ${rows.length} snapshots`);
  }

  // 6. Drop the old single "bbb3-final" snapshot wherever real history now exists.
  let removed = 0;
  for (const part of chunk(allCardIds, 5000)) {
    const res = await prisma.scoreSnapshot.deleteMany({
      where: { seasonSlug: SEASON_SLUG, gameweek: `${SEASON_SLUG}-final`, teamCardId: { in: part } },
    });
    removed += res.count;
  }
  log(`[bbb3-history] removed ${removed} superseded "${SEASON_SLUG}-final" snapshots`);

  // 7. Print the finals leaderboard so the result can be checked against
  // SBS's tweet (VViIIis #1146 should be first at 209.72).
  const finals = await prisma.scoreSnapshot.findMany({
    where: { seasonSlug: SEASON_SLUG, gameweek: gameweekFor(WEEKS), team: { status: "finals" } },
    include: { team: { include: { owner: true } } },
    orderBy: { weeklyScore: "desc" },
    take: 10,
  });
  log(`[bbb3-history] finals top 10:`);
  finals.forEach((r, i) => {
    const name = r.team.owner.displayName ?? r.team.ownerWallet;
    log(`  ${String(i + 1).padStart(2)}. ${name.padEnd(24)} #${r.teamCardId.padEnd(6)} ${r.weeklyScore.toFixed(2)}`);
  });
}

main()
  .catch((err) => {
    writeSync(2, `[bbb3-history] ERROR: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

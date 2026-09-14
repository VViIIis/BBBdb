import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import { DRAFT_ID_RANGES, getCurrentGameweek, getFullStandings, getUserProfiles, SbsStandingsRow } from "@/lib/sbsApi";

// Same rationale as syncLeaderboard.ts: writeSync bypasses stdout buffering
// so a checkpoint log actually lands before a hang/timeout kills the process.
function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

// Same rateLimited-flagged-error convention as sbsApi.ts/opensea.ts, retried
// with the same backoff shape sync-collection.ts already uses for OpenSea
// (1000ms * attempt, up to 5 attempts) — confirmed necessary against the
// real site: a first real run at CONCURRENCY=8 with no retry logic started
// getting HTTP 429s from sbsfantasy.com a few hundred pods in, and the
// (then-unhandled) 429 on the display-batch profile call aborted the WHOLE
// run — including the DB write phase, which hadn't happened yet — throwing
// away ~11,400 already-fetched scores that were sitting in memory. Retrying
// (here) and making the profile fetch non-fatal (below) fixes both.
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.rateLimited && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      // Caller logs the final failure with its own context (which draftId,
      // which profile batch) — avoid double-logging here.
      throw err;
    }
  }
}

/**
 * Full score coverage, unlike syncLeaderboard.ts (which only ever sees the
 * global top-500 scorers via /api/leaderboard). This walks EVERY pod
 * (draftId) in DRAFT_ID_RANGES and pulls that pod's complete standings via
 * /api/standings, so a team scoring well below the global top-500 — the
 * normal case for most teams — still gets a ScoreSnapshot.
 *
 * Much heavier than syncLeaderboard.ts (~1500 HTTP calls vs. a handful), so
 * it's a separate, less-frequent job — same relationship as
 * sync-collection.ts (heavy, daily) has to syncLeaderboard.ts (light,
 * frequent). Keep syncLeaderboard.ts running too: it's cheap and keeps the
 * homepage "current gameweek" / top-scorers view fresh between full runs.
 *
 * Safe to re-run or interrupt: every write is an upsert, so a partial run
 * just leaves later pods unrefreshed until the next run — nothing corrupts.
 */
export async function runSyncStandings() {
  // Lowered from an initial 8 after a real run showed sbsfantasy.com
  // starting to 429 a few hundred pods in at that concurrency — 4 plus the
  // retry/backoff above is gentler and still finishes well inside the CLI
  // wrapper's watchdog.
  const CONCURRENCY = Number(process.env.STANDINGS_SYNC_CONCURRENCY ?? 4);

  log("[sync-standings] looking up active season...");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error("No active season found — seed a Season row with isActive=true first.");
  }
  log(`[sync-standings] season: ${season.slug}`);

  const syncLogRow = await prisma.syncLog.create({ data: { source: "sbs-standings-full" } });

  try {
    const gameweek = await getCurrentGameweek();
    log(`[sync-standings] gameweek: ${gameweek}`);

    const draftIds: string[] = [];
    for (const { prefix, max } of DRAFT_ID_RANGES) {
      for (let n = 1; n <= max; n++) draftIds.push(`${prefix}${n}`);
    }
    log(`[sync-standings] walking ${draftIds.length} candidate pods (most will miss — that's expected)...`);

    // rowsByCardId, not a plain array: a card should only ever appear in one
    // pod, but de-duping defensively costs nothing and protects against any
    // future overlap (e.g. an advancement-round pod re-listing finals teams).
    const rowsByCardId = new Map<string, SbsStandingsRow>();
    let hitPods = 0;
    let checked = 0;
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < draftIds.length) {
        const draftId = draftIds[nextIdx++];
        try {
          const rows = await withRetry(() => getFullStandings(gameweek, draftId), `draftId ${draftId}`);
          if (rows.length > 0) {
            hitPods++;
            for (const row of rows) rowsByCardId.set(row.cardId, row);
          }
        } catch (err) {
          // Undocumented endpoint, walking mostly-invalid ids on purpose —
          // log and move on rather than letting one bad id kill the whole run.
          log(`[sync-standings] draftId ${draftId} failed: ${String(err)}`);
        }
        checked++;
        if (checked % 200 === 0) {
          log(`[sync-standings] ...${checked}/${draftIds.length} pods checked (${hitPods} hit, ${rowsByCardId.size} teams so far)`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const rows = [...rowsByCardId.values()];
    log(`[sync-standings] found ${rows.length} scored teams across ${hitPods} live pods, fetching owner profiles...`);

    const wallets = [...new Set(rows.map((r) => r.ownerWallet))];
    const profiles: Record<string, Awaited<ReturnType<typeof getUserProfiles>>[string]> = {};
    const PROFILE_BATCH = 50;
    for (let i = 0; i < wallets.length; i += PROFILE_BATCH) {
      const batchWallets = wallets.slice(i, i + PROFILE_BATCH);
      try {
        Object.assign(profiles, await withRetry(() => getUserProfiles(batchWallets), `profile batch ${i}`));
      } catch (err) {
        // Display name/avatar is cosmetic, not the point of this job — an
        // owner just falls back to a shortened wallet address on the site
        // (see shortWallet() on the Leaderboard/Owner pages) if we can't get
        // their profile. NOT worth aborting the whole run over (and losing
        // every score we already fetched) the way the un-caught version of
        // this call did on 2026-09-14's first real run.
        log(`[sync-standings] profile batch ${i}/${wallets.length} failed, continuing without it: ${String(err)}`);
      }
    }
    log(`[sync-standings] profiles fetched, writing ${rows.length} rows to DB...`);

    // Same batching rationale as syncLeaderboard.ts: owners first (de-duped,
    // sequential batches, to avoid two teams owned by the same wallet racing
    // to create the same Owner row), then team+score rows in parallel
    // batches (safe — `rows` is already de-duped by cardId).
    const WRITE_BATCH = 15;

    const ownersByWallet = new Map<string, SbsStandingsRow>();
    for (const row of rows) {
      if (!ownersByWallet.has(row.ownerWallet)) ownersByWallet.set(row.ownerWallet, row);
    }
    const uniqueOwners = [...ownersByWallet.values()];

    for (let i = 0; i < uniqueOwners.length; i += WRITE_BATCH) {
      const batch = uniqueOwners.slice(i, i + WRITE_BATCH);
      await Promise.all(
        batch.map((row) => {
          const profile = profiles[row.ownerWallet];
          return prisma.owner.upsert({
            where: { wallet: row.ownerWallet },
            create: {
              wallet: row.ownerWallet,
              displayName: profile?.displayName,
              imageUrl: profile?.imageUrl ?? null,
              equippedBadge: profile?.equippedBadge ?? null,
              ripenessTier: profile?.ripeness?.tier ?? null,
              ripenessLabel: profile?.ripeness?.label ?? null,
              ripenessCount: profile?.ripeness?.count ?? null,
            },
            update: profile
              ? {
                  displayName: profile.displayName,
                  imageUrl: profile.imageUrl ?? null,
                  equippedBadge: profile.equippedBadge ?? null,
                  ripenessTier: profile.ripeness?.tier ?? null,
                  ripenessLabel: profile.ripeness?.label ?? null,
                  ripenessCount: profile.ripeness?.count ?? null,
                }
              : {},
          });
        }),
      );
    }
    log(`[sync-standings] wrote ${uniqueOwners.length} owners, writing team + score rows...`);

    let written = 0;
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const batch = rows.slice(i, i + WRITE_BATCH);
      await Promise.all(
        batch.map(async (row) => {
          await prisma.team.upsert({
            where: { seasonSlug_cardId: { seasonSlug: season.slug, cardId: row.cardId } },
            create: {
              cardId: row.cardId,
              seasonSlug: season.slug,
              leagueId: row.leagueId,
              leagueName: row.leagueName,
              level: row.level,
              ownerWallet: row.ownerWallet,
            },
            update: {
              leagueId: row.leagueId,
              leagueName: row.leagueName,
              level: row.level,
              ownerWallet: row.ownerWallet,
            },
          });

          await prisma.scoreSnapshot.upsert({
            where: {
              seasonSlug_teamCardId_gameweek: { seasonSlug: season.slug, teamCardId: row.cardId, gameweek },
            },
            create: {
              seasonSlug: season.slug,
              teamCardId: row.cardId,
              gameweek,
              rank: row.rank,
              weeklyScore: row.weeklyScore,
              seasonScore: row.seasonScore,
            },
            update: {
              rank: row.rank,
              weeklyScore: row.weeklyScore,
              seasonScore: row.seasonScore,
              capturedAt: new Date(),
            },
          });

          written++;
        }),
      );
      if ((i + WRITE_BATCH) % 150 < WRITE_BATCH) {
        log(`[sync-standings] wrote ${Math.min(i + WRITE_BATCH, rows.length)}/${rows.length} team+score rows...`);
      }
    }

    log(`[sync-standings] wrote ${written} rows, cleaning up phantom rows...`);

    // One-time (per run, effectively self-limiting after the first) cleanup
    // for a now-fixed bug: getFullStandings() used to key legacy promo/
    // Wheel/Banana-Race picks (JackHOF/HOF "from ..." pods, under the
    // 2025-slow-draft- prefix) by SBS's synthetic per-pick `_cardId`
    // (e.g. "special-1788005018303-966d3b") instead of `card.realTokenId`
    // (the actual NFT token id). That wrote real scores under a cardId
    // that never matched the real, OpenSea-sourced Team row for that
    // token — so the real team showed no score, AND a phantom Team row
    // (no roster, no image, since OpenSea sync never creates one for a
    // fake id) piled up here every run. The extraction is fixed above;
    // this deletes whatever phantom rows already accumulated before the
    // fix, for THIS season only. Children first (FK is ON DELETE
    // RESTRICT) — safe to re-run: matches 0 rows once cleaned up.
    const phantomWhere = { seasonSlug: season.slug, cardId: { startsWith: "special-" } };
    const phantomTeams = await prisma.team.findMany({ where: phantomWhere, select: { cardId: true } });
    if (phantomTeams.length > 0) {
      const phantomCardIds = phantomTeams.map((t: { cardId: string }) => t.cardId);
      const teamRef = { seasonSlug: season.slug, cardId: { in: phantomCardIds } };
      const [deletedScores, deletedRoster, deletedSales] = await Promise.all([
        prisma.scoreSnapshot.deleteMany({ where: { seasonSlug: season.slug, teamCardId: { in: phantomCardIds } } }),
        prisma.rosterSlot.deleteMany({ where: { seasonSlug: season.slug, teamCardId: { in: phantomCardIds } } }),
        prisma.sale.deleteMany({ where: { seasonSlug: season.slug, teamCardId: { in: phantomCardIds } } }),
      ]);
      const deletedTeams = await prisma.team.deleteMany({ where: teamRef });
      log(
        `[sync-standings] removed ${deletedTeams.count} phantom "special-*" team rows ` +
          `(${deletedScores.count} scores, ${deletedRoster.count} roster slots, ${deletedSales.count} sales)`,
      );
    } else {
      log("[sync-standings] no phantom rows to clean up");
    }

    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), recordCount: written, ok: true },
    });

    return { gameweek, pods: hitPods, written };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

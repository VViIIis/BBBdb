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
    log(`[sync-standings] found ${rows.length} scored teams across ${hitPods} live pods, resolving synthetic pick ids...`);

    // Wheel/Promo/Banana-Race picks: when SBS hasn't linked a pick to its
    // real minted NFT token yet, /api/standings returns a synthetic
    // per-pick cardId (e.g. "special-1783561176466-0") instead of the real
    // token id — getFullStandings()'s realTokenId-first extraction can't
    // help here because SBS's response just doesn't have a realTokenId for
    // these yet. Writing a score straight under that synthetic id used to
    // create a "phantom" Team row that the cleanup step below deletes every
    // run, silently throwing the score away with it — it never reached the
    // REAL Team row (the one scripts/sync-collection.ts already created
    // under the real minted token id, discovered independently via
    // OpenSea). Confirmed live 2026-09-15: AceJohn's real cardId 2060
    // ("Jackpot #26 (from Wheel)") shows a genuine 200.78 season score on
    // sbsfantasy.com, filed under pick id "special-1783561176466-0" — our
    // DB never saw it because of exactly this.
    //
    // Fix: a synthetic pick and its real card are the same team, so they
    // share the same pod (`leagueId`, i.e. SBS's own `_leagueId` — stable
    // regardless of which sync/endpoint discovered the Team row) and the
    // same owner, and a pod only has one pick per owner — so
    // (leagueId, ownerWallet) is enough to find the real cardId already
    // sitting in our Team table and redirect the score onto it instead.
    const specialRows = rows.filter((r) => r.cardId.startsWith("special-"));
    if (specialRows.length > 0) {
      const candidateWallets = [...new Set(specialRows.map((r) => r.ownerWallet))];
      const candidates = await prisma.team.findMany({
        where: { seasonSlug: season.slug, ownerWallet: { in: candidateWallets }, status: { not: "draft_pass" } },
        select: { cardId: true, leagueId: true, ownerWallet: true },
      });
      const byPodOwner = new Map<string, string[]>();
      for (const c of candidates) {
        const key = `${c.leagueId}::${c.ownerWallet}`;
        const arr = byPodOwner.get(key);
        if (arr) arr.push(c.cardId);
        else byPodOwner.set(key, [c.cardId]);
      }
      let resolved = 0;
      for (const row of specialRows) {
        const matches = byPodOwner.get(`${row.leagueId}::${row.ownerWallet}`) ?? [];
        if (matches.length === 1) {
          row.cardId = matches[0]; // mutates in place — same object rowsByCardId/rows already hold
          resolved++;
        }
        // 0 matches: real card not minted/synced yet (sync-collection.ts
        // will pick it up eventually, and the NEXT standings run will
        // resolve it then). >1 matches: genuinely ambiguous — in either
        // case, leave row.cardId as "special-*" so it gets filtered out
        // below rather than risk attaching the score to the wrong team.
      }
      log(
        `[sync-standings] resolved ${resolved}/${specialRows.length} synthetic pick ids to real cards ` +
          `(${specialRows.length - resolved} left unmatched — not minted/synced yet, or ambiguous)`,
      );
    }

    // Drop whatever's still under a synthetic id (unresolved above) instead
    // of writing it — same reasoning the old phantom-row cleanup below was
    // patching up after the fact, just done BEFORE writing instead of
    // after deleting. Re-dedupe by the now-real cardId too: extremely
    // unlikely for two rows to resolve to the same card, but cheap to
    // guard against (keep whichever has the higher season score).
    const finalRowsByCardId = new Map<string, SbsStandingsRow>();
    for (const row of rows) {
      if (row.cardId.startsWith("special-")) continue;
      const existing = finalRowsByCardId.get(row.cardId);
      if (!existing || row.seasonScore > existing.seasonScore) finalRowsByCardId.set(row.cardId, row);
    }
    const finalRows = [...finalRowsByCardId.values()];
    log(`[sync-standings] ${finalRows.length} rows ready to write (fetching owner profiles...)`);

    const wallets = [...new Set(finalRows.map((r) => r.ownerWallet))];
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
    log(`[sync-standings] profiles fetched, writing ${finalRows.length} rows to DB...`);

    // Same batching rationale as syncLeaderboard.ts: owners first (de-duped,
    // sequential batches, to avoid two teams owned by the same wallet racing
    // to create the same Owner row), then team+score rows in parallel
    // batches (safe — `finalRows` is already de-duped by (real) cardId).
    //
    // Lowered from 15 after the project flipped to "unhealthy" on Supabase's
    // free tier mid-run on 2026-09-16 (both a local run and the GitHub
    // Actions cron run failed with "Can't reach database server" around the
    // same time) — Supabase's own logs showed no errors and normal
    // checkpoint activity once it recovered, consistent with the free
    // tier's small shared compute getting overwhelmed by ~13,700 rows'
    // worth of sustained 15-wide parallel upserts rather than any actual
    // outage. 5 keeps meaningful pipelining without hitting the DB as hard;
    // override with STANDINGS_SYNC_WRITE_BATCH if it needs further tuning.
    const WRITE_BATCH = Number(process.env.STANDINGS_SYNC_WRITE_BATCH ?? 5);

    const ownersByWallet = new Map<string, SbsStandingsRow>();
    for (const row of finalRows) {
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
    for (let i = 0; i < finalRows.length; i += WRITE_BATCH) {
      const batch = finalRows.slice(i, i + WRITE_BATCH);
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
        log(`[sync-standings] wrote ${Math.min(i + WRITE_BATCH, finalRows.length)}/${finalRows.length} team+score rows...`);
      }
    }

    log(`[sync-standings] wrote ${written} rows, cleaning up phantom rows...`);

    // One-time (per run, effectively self-limiting after the first) sweep
    // for phantom Team rows that accumulated BEFORE the synthetic-pick-id
    // resolution step above existed: every run of this job used to upsert
    // a Team + ScoreSnapshot straight under SBS's synthetic per-pick
    // `_cardId` (e.g. "special-1788005018303-966d3b") for any Wheel/Promo/
    // Banana-Race pick /api/standings hadn't linked to a real minted token
    // yet — creating a Team row (no roster, no image, since OpenSea sync
    // never creates one for a fake id) that never matched the real,
    // OpenSea-sourced Team row for that same pick, so the real team showed
    // no score. The resolution step above now catches this BEFORE writing
    // (matching by pod + owner and redirecting the score onto the real
    // cardId, or skipping it if no real Team row exists yet) — so no NEW
    // phantom rows should appear here going forward. This cleanup now
    // exists only to sweep whatever phantom rows already accumulated
    // before that fix landed (2026-09-15), for THIS season only, plus
    // defense-in-depth for any future edge case. Children first (FK is ON
    // DELETE RESTRICT) — safe to re-run: matches 0 rows once cleaned up.
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

import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import { getWalletMarketplaceActivity, SbsMarketplaceActivity } from "@/lib/sbsApi";

// Same rationale as syncLeaderboard.ts: writeSync bypasses stdout buffering
// so a checkpoint log actually lands before a hang/timeout kills the process.
function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

// Same rateLimited-flagged-error + backoff convention as syncStandings.ts —
// this hits the same sbsfantasy.com domain, at a similar (larger) call
// volume (one call per known wallet, ~3,200+ and growing), so assume it
// needs the same gentleness from the start rather than re-discovering that
// the hard way with a real crashed run like syncStandings.ts's first one did.
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
 * Fills the gap sync-sales.ts (OpenSea) can't: sales that happen through
 * SBS's OWN in-app marketplace, which never get reported to OpenSea's
 * public sale-events feed at all (see the big docblock on
 * getWalletMarketplaceActivity in sbsApi.ts for how this was confirmed).
 *
 * There's no collection-wide activity feed on this API, only per-wallet, so
 * this walks every wallet this project already knows about (the `Owner`
 * table — global, never pruned) and pulls each one's activity, keeping only
 * `type: "buy"` entries (a buy entry is self-sufficient to reconstruct the
 * whole sale — see sbsApi.ts, no need to also look at the seller's `sell`
 * entry for the same trade). Writes land in the same `Sale` table
 * sync-sales.ts uses, distinguished by `marketplace: "sbs"` (vs.
 * `"opensea"`) and an `sbs-`-prefixed eventKey so the two sources can never
 * collide even if they somehow both ever saw the same trade.
 *
 * Only ever targets the currently active season, same assumption
 * syncStandings.ts makes: SBS's in-app marketplace is for the live
 * collection, not a concluded/imported one like bbb3.
 *
 * Safe to re-run or interrupt: every write is an upsert keyed on eventKey,
 * and a sale is never re-written once stored (matches sync-sales.ts) — a
 * partial run just means some wallets' activity gets picked up next time.
 */
export async function runSyncSbsTrades() {
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error("No active season found — seed a Season row with isActive=true first.");
  }
  log(`[sync-sbs-trades] season: ${season.slug}`);

  const syncLogRow = await prisma.syncLog.create({ data: { source: "sbs-marketplace-sales" } });

  try {
    const owners = await prisma.owner.findMany({ select: { wallet: true } });
    log(`[sync-sbs-trades] checking marketplace activity for ${owners.length} known wallets...`);

    // Lowered starting point vs. syncStandings.ts's CONCURRENCY=4 default —
    // this makes MORE calls in total (one per wallet, ~3,200+, vs. ~1,600
    // candidate pods there), so start a little gentler and tune from a real
    // run's behavior the same way that job's concurrency got tuned down.
    const CONCURRENCY = Number(process.env.SBS_TRADES_SYNC_CONCURRENCY ?? 3);

    const buys: SbsMarketplaceActivity[] = [];
    let checked = 0;
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < owners.length) {
        const wallet = owners[nextIdx++].wallet;
        try {
          let cursor: string | undefined;
          do {
            const page = await withRetry(() => getWalletMarketplaceActivity(wallet, cursor));
            for (const a of page.activities) {
              if (a.type === "buy") buys.push(a);
            }
            cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
          } while (cursor);
        } catch (err) {
          // Undocumented endpoint, one call per wallet on purpose — log and
          // move on rather than letting one bad wallet kill the whole run.
          log(`[sync-sbs-trades] wallet ${wallet} failed: ${String(err)}`);
        }
        checked++;
        if (checked % 500 === 0) {
          log(`[sync-sbs-trades] ...${checked}/${owners.length} wallets checked (${buys.length} buys found so far)`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    log(`[sync-sbs-trades] found ${buys.length} buy events across ${owners.length} wallets, writing to DB...`);

    let written = 0;
    let skippedNoTeam = 0;
    let skippedUnusable = 0;
    for (const a of buys) {
      const key = a.orderHash ?? a.txHash;
      if (!key || !a.counterparty) {
        skippedUnusable++;
        continue;
      }
      const eventKey = `sbs-${key}-${a.tokenId}`;

      // Same self-healing skip as sync-sales.ts: the team has to already
      // exist (from sync-collection.ts / sync-standings.ts) for the FK on
      // Sale to succeed.
      const team = await prisma.team.findUnique({
        where: { seasonSlug_cardId: { seasonSlug: season.slug, cardId: a.tokenId } },
        select: { cardId: true },
      });
      if (!team) {
        skippedNoTeam++;
        continue;
      }

      await prisma.sale.upsert({
        where: { eventKey },
        create: {
          eventKey,
          seasonSlug: season.slug,
          teamCardId: a.tokenId,
          occurredAt: new Date(a.timestamp),
          txHash: a.txHash,
          fromWallet: a.counterparty,
          toWallet: a.walletAddress,
          priceEth: a.price,
          paymentSymbol: "USDC",
          marketplace: "sbs",
        },
        update: {}, // a sale is a historical fact once written — never re-write it
      });
      written++;
    }

    log(
      `[sync-sbs-trades] done: wrote ${written}, skipped ${skippedNoTeam} (team not synced yet), skipped ${skippedUnusable} (unusable event)`,
    );
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), recordCount: written, ok: true },
    });
    return { written, skippedNoTeam, skippedUnusable, walletsChecked: owners.length };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

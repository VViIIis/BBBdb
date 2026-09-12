import { writeSync } from "fs";
import { prisma } from "@/lib/db";
import { getCollectionSaleEvents, type OpenSeaSaleEvent } from "@/lib/opensea";

// Same rationale as syncLeaderboard.ts: writeSync bypasses stdout buffering
// so log lines survive a killed/hung CI process.
function log(msg: string) {
  writeSync(1, `${msg}\n`);
}

const OVERLAP_SECONDS = 300; // re-request the last 5 min of already-synced time every run, in case OpenSea's own event ordering isn't strictly monotonic at the boundary — harmless, since eventKey's unique constraint makes re-seeing the same sale a no-op

function eventOccurredAtSeconds(e: OpenSeaSaleEvent): number | null {
  return e.closing_date ?? e.event_timestamp ?? null;
}

/** Synthesizes a stable idempotency key from whatever OpenSea gives us for
 * this event, since the events payload doesn't expose one obvious canonical
 * id. Returns null when neither a tx hash nor an order hash is present —
 * those events are skipped rather than risk a duplicate/garbage row. */
function eventKeyFor(e: OpenSeaSaleEvent, cardId: string): string | null {
  const tx = typeof e.transaction === "string" ? e.transaction : null;
  if (tx) return `${tx}-${cardId}`;
  if (e.order_hash) return `${e.order_hash}-${cardId}`;
  return null;
}

/**
 * Pulls marketplace SALE events (not plain transfers/mints/gifts) for a
 * season's collection from OpenSea and stores them in the `Sale` table —
 * powers /trades ("what's being traded, and by whom"). Only ever targets
 * ONE season per call; there's no cross-season sales page, so this is
 * simpler than syncLeaderboard.ts on purpose.
 *
 * Incremental by design: each run asks OpenSea only for events after the
 * latest `occurredAt` already stored for this season (minus a small overlap
 * buffer — see OVERLAP_SECONDS), then pages forward with the `next` cursor
 * until OpenSea reports no more pages. The very first run for a season has
 * no lower bound, so it walks that collection's FULL sale history — expect
 * that one run to make many more calls / take longer than every run after
 * it, which should typically be 1-2 pages.
 */
export async function runSyncSales(seasonSlugArg?: string) {
  const season = seasonSlugArg
    ? await prisma.season.findUnique({ where: { slug: seasonSlugArg } })
    : await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error(
      `No season found (seasonSlug=${seasonSlugArg ?? "<unset, looked for isActive>"}).`,
    );
  }
  if (!season.collectionSlug) {
    throw new Error(
      `Season "${season.slug}" has no collectionSlug set (see prisma/schema.prisma) — set one ` +
        `(e.g. "banana-best-ball-4", from the season's opensea.io/collection/<slug> URL) before running sales sync.`,
    );
  }
  log(`[sync-sales] season: ${season.slug} (collection: ${season.collectionSlug})`);

  const syncLogRow = await prisma.syncLog.create({ data: { source: "opensea-sales" } });

  try {
    const latest = await prisma.sale.findFirst({
      where: { seasonSlug: season.slug },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });
    const occurredAfter = latest
      ? Math.floor(latest.occurredAt.getTime() / 1000) - OVERLAP_SECONDS
      : undefined;
    log(
      occurredAfter != null
        ? `[sync-sales] incremental sync from ${new Date(occurredAfter * 1000).toISOString()}`
        : `[sync-sales] no prior sales stored for this season — pulling full history (first run, may take a while)`,
    );

    let cursor: string | undefined;
    let page = 0;
    let written = 0;
    let skippedNoTeam = 0;
    let skippedUnusable = 0;
    let loggedSample = false;

    do {
      const { events, next } = await getCollectionSaleEvents(season.collectionSlug, {
        cursor,
        occurredAfter,
      });
      page++;
      if (!loggedSample && events.length > 0) {
        // See the big comment in src/lib/opensea.ts — this line is the
        // fastest way to catch a field-name mismatch on the first real run.
        log(`[sync-sales] sample raw event (page 1): ${JSON.stringify(events[0])}`);
        loggedSample = true;
      }
      log(`[sync-sales] page ${page}: ${events.length} sale events`);

      for (const e of events) {
        const cardId = e.nft?.identifier;
        const occurredAtSec = cardId ? eventOccurredAtSeconds(e) : null;
        const key = cardId && occurredAtSec != null ? eventKeyFor(e, cardId) : null;
        if (!cardId || occurredAtSec == null || !key || !e.seller || !e.buyer) {
          skippedUnusable++;
          continue;
        }

        // The team has to already exist (from sync-collection.ts) for the
        // FK on Sale to succeed. If it doesn't yet, skip for now — this
        // self-heals the next time sync-collection.ts catches up to this
        // token id, since sales aren't upsert-overwritten, just re-tried.
        const team = await prisma.team.findUnique({
          where: { seasonSlug_cardId: { seasonSlug: season.slug, cardId } },
          select: { cardId: true },
        });
        if (!team) {
          skippedNoTeam++;
          continue;
        }

        const priceEth =
          e.payment && e.payment.decimals != null && e.payment.quantity != null
            ? Number(e.payment.quantity) / 10 ** e.payment.decimals
            : null;

        await prisma.sale.upsert({
          where: { eventKey: key },
          create: {
            eventKey: key,
            seasonSlug: season.slug,
            teamCardId: cardId,
            occurredAt: new Date(occurredAtSec * 1000),
            txHash: typeof e.transaction === "string" ? e.transaction : null,
            fromWallet: e.seller.toLowerCase(),
            toWallet: e.buyer.toLowerCase(),
            priceEth,
            paymentSymbol: e.payment?.symbol ?? null,
            marketplace: "opensea",
          },
          update: {}, // a sale is a historical fact once written — never re-write it
        });
        written++;
      }

      cursor = next ?? undefined;
    } while (cursor);

    log(
      `[sync-sales] done: wrote ${written}, skipped ${skippedNoTeam} (team not synced yet), skipped ${skippedUnusable} (unusable event)`,
    );
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), recordCount: written, ok: true },
    });
    return { written, skippedNoTeam, skippedUnusable };
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: syncLogRow.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  }
}

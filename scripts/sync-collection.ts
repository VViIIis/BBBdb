import "dotenv/config";
/**
 * Walks every token id in a season's NFT collection (1..maxTokenId) and
 * upserts a Team + minimal Owner row for each one, scoped to that season —
 * this is what makes team lookup complete beyond sbsfantasy.com's
 * top-500-scorer leaderboard cap (see scripts/sync-leaderboard.ts and
 * src/lib/sbsApi.ts for that limitation). See src/lib/opensea.ts for how
 * this was verified against real API responses before being trusted.
 *
 * Which season it syncs: pass SEASON_SLUG=bbb4 (etc) to target a specific
 * one, or leave it unset to sync whichever Season row has isActive=true.
 * Contract address and chain come from that Season row in the database —
 * NOT from env vars — so a season's identity lives in one place. This
 * script is for a LIVE, ongoing season; a concluded season you're
 * importing after the fact (like BBB III) uses scripts/import-season.ts
 * instead, which doesn't need to keep re-running.
 *
 * This is a MUCH heavier pull than sync-leaderboard.ts (thousands of
 * individual API calls) — run it far less often (daily is plenty; roster
 * composition and ownership change much slower than weekly scores).
 * Requires OPENSEA_API_KEY.
 *
 * Safe to re-run or interrupt: every write is an upsert keyed by
 * (season, cardId), so stopping partway through and re-running just
 * continues (starting over from id 1, not resuming — the DB rows already
 * written are simply re-upserted with the same data, which is harmless,
 * just not instant).
 */
import { prisma } from "../src/lib/db";
import { getNftByTokenId, getRosterSlots, traitValue } from "../src/lib/opensea";

const MAX_TOKEN_ID = Number(process.env.OPENSEA_MAX_TOKEN_ID ?? 14040);
const CONCURRENCY = Number(process.env.OPENSEA_SYNC_CONCURRENCY ?? 4);

async function resolveSeason() {
  const slug = process.env.SEASON_SLUG;
  const season = slug
    ? await prisma.season.findUnique({ where: { slug } })
    : await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error(
      `No season found (SEASON_SLUG=${slug ?? "<unset, looked for isActive>"}). Seed a Season row first.`,
    );
  }
  return season;
}

async function upsertToken(
  season: { slug: string; contract: string; chain: string },
  tokenId: number,
): Promise<"team" | "draft-pass" | "missing" | "no-owner"> {
  const nft = await getNftByTokenId(season.contract, String(tokenId), season.chain);
  if (!nft) return "missing";

  const ownerWallet = nft.owners?.[0]?.address?.toLowerCase();
  if (!ownerWallet) return "no-owner";

  const status = String(traitValue(nft, "Status") ?? "Unknown");
  const isDraftPass = status.toLowerCase() === "draft pass";
  const level = String(traitValue(nft, "Level") ?? "Unknown"); // absent for undrafted passes
  const leagueNum = traitValue(nft, "League #");
  const leagueId = leagueNum != null ? `sbs-league-${leagueNum}` : `opensea-${tokenId}`;
  const leagueName = leagueNum != null ? `BBB #${leagueNum}` : `Draft Pass #${tokenId}`;
  const cardId = String(tokenId);

  await prisma.owner.upsert({
    where: { wallet: ownerWallet },
    create: { wallet: ownerWallet },
    update: {}, // never clobber displayName/avatar set by sync-leaderboard.ts
  });

  await prisma.team.upsert({
    where: { seasonSlug_cardId: { seasonSlug: season.slug, cardId } },
    create: {
      cardId,
      seasonSlug: season.slug,
      leagueId,
      leagueName,
      level: isDraftPass ? "Unknown" : level,
      ownerWallet,
      status: isDraftPass ? "draft_pass" : "active",
    },
    update: {
      // Ownership changes hands via trading — always trust OpenSea/on-chain
      // as the source of truth for current holder.
      ownerWallet,
      status: isDraftPass ? "draft_pass" : "active",
    },
  });

  // Roster slots power the exposure page (src/app/exposure). Assumed
  // immutable once drafted, so this is insert-only (skipDuplicates) rather
  // than a full upsert — much cheaper on a re-sync than re-writing every
  // slot on every one of ~14k tokens when only ownership actually changes.
  if (!isDraftPass) {
    const roster = getRosterSlots(nft);
    if (roster.length > 0) {
      await prisma.rosterSlot.createMany({
        data: roster.map((r) => ({
          seasonSlug: season.slug,
          teamCardId: cardId,
          slot: r.slot,
          value: r.value,
        })),
        skipDuplicates: true,
      });
    }
  }

  return isDraftPass ? "draft-pass" : "team";
}

async function main() {
  const season = await resolveSeason();
  console.log(`[sync-collection] syncing season "${season.slug}" (${season.chain}:${season.contract})`);

  const log = await prisma.syncLog.create({ data: { source: "opensea-collection" } });
  const counts = { team: 0, "draft-pass": 0, missing: 0, "no-owner": 0, errors: 0 };

  try {
    let nextId = 1;
    async function worker() {
      while (nextId <= MAX_TOKEN_ID) {
        const tokenId = nextId++;
        let attempt = 0;
        for (;;) {
          try {
            const result = await upsertToken(season, tokenId);
            counts[result]++;
            break;
          } catch (err: any) {
            attempt++;
            if (err?.rateLimited && attempt <= 5) {
              await new Promise((r) => setTimeout(r, 1000 * attempt));
              continue;
            }
            // Race condition between concurrent workers: two tokens owned by
            // the same wallet can both try to INSERT that Owner row at the
            // same instant (common — many wallets hold several teams).
            // Postgres correctly rejects the loser; just retry it — the
            // owner row now exists, so the retry takes the update path.
            const isUniqueConstraintRace =
              err?.code === "P2002" || /Unique constraint failed/i.test(String(err));
            if (isUniqueConstraintRace && attempt <= 5) {
              await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
              continue;
            }
            counts.errors++;
            console.error(`[sync-collection] token ${tokenId} failed:`, String(err));
            break;
          }
        }
        if (tokenId % 250 === 0) {
          console.log(
            `[sync-collection] ...${tokenId}/${MAX_TOKEN_ID} checked (teams=${counts.team}, draft-passes=${counts["draft-pass"]}, errors=${counts.errors})`,
          );
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const total = counts.team + counts["draft-pass"];
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), recordCount: total, ok: true },
    });
    console.log(`[sync-collection] done.`, counts);
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), ok: false, errorText: String(err) },
    });
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "dotenv/config";
/**
 * One-time importer for a CONCLUDED season — unlike sync-collection.ts
 * (which is meant to keep re-running against a live season), this pulls a
 * final snapshot from OpenSea's frozen NFT metadata and writes it once.
 * There's no live SBS leaderboard API for a season that's already over, so
 * "final standings" here come entirely from whatever the collection's
 * traits still show (RANK / WEEK-SCORE / SEASON-SC0RE), which SBS appears
 * to freeze in place once a season ends rather than erase.
 *
 * Defaults to BBB III (Jack's win!) — override the env vars below to
 * import a different past season later (BBB II, etc.):
 *
 *   SEASON_SLUG=bbb3 SEASON_NAME="Banana Best Ball III" \
 *   SEASON_CHAIN=ethereum SEASON_CONTRACT=0x2bff... \
 *   SEASON_MAX_TOKEN_ID=12130 npx tsx scripts/import-season.ts
 *
 * Safe to re-run: every write is an upsert. Verify traits against a real
 * response for a NEW season before trusting this blindly — we confirmed
 * BBB IV's trait names live (see src/lib/opensea.ts's doc comment) but have
 * NOT yet done the same live check for BBB III specifically. If numbers
 * look wrong after running this, console.log one `nft` and compare its
 * trait_type strings to what upsertToken() below expects.
 */
import { prisma } from "../src/lib/db";
import { getNftByTokenId, getRosterSlots, traitValue } from "../src/lib/opensea";
import { getUserProfiles } from "../src/lib/sbsApi";

const SEASON_SLUG = process.env.SEASON_SLUG ?? "bbb3";
const SEASON_NAME = process.env.SEASON_NAME ?? "Banana Best Ball III";
const SEASON_CHAIN = process.env.SEASON_CHAIN ?? "ethereum";
const SEASON_CONTRACT = (
  process.env.SEASON_CONTRACT ?? "0x2bff6f4284774836d867ced2e9b96c27aaee55b7"
).toLowerCase();
const MAX_TOKEN_ID = Number(process.env.SEASON_MAX_TOKEN_ID ?? 12130);
const CONCURRENCY = Number(process.env.OPENSEA_SYNC_CONCURRENCY ?? 4);
const FINAL_GAMEWEEK = `${SEASON_SLUG}-final`;

function parseFinalNumber(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsertToken(
  tokenId: number,
): Promise<"team" | "draft-pass" | "missing" | "no-owner"> {
  const nft = await getNftByTokenId(SEASON_CONTRACT, String(tokenId), SEASON_CHAIN);
  if (!nft) return "missing";

  const ownerWallet = nft.owners?.[0]?.address?.toLowerCase();
  if (!ownerWallet) return "no-owner";

  const status = String(traitValue(nft, "Status") ?? "Unknown");
  const isDraftPass = status.toLowerCase() === "draft pass";
  const level = String(traitValue(nft, "Level") ?? "Unknown");
  const leagueNum = traitValue(nft, "League #");
  const leagueId = leagueNum != null ? `sbs-league-${leagueNum}` : `opensea-${tokenId}`;
  const leagueName = leagueNum != null ? `BBB #${leagueNum}` : `Draft Pass #${tokenId}`;
  const cardId = String(tokenId);

  await prisma.owner.upsert({
    where: { wallet: ownerWallet },
    create: { wallet: ownerWallet },
    update: {},
  });

  await prisma.team.upsert({
    where: { seasonSlug_cardId: { seasonSlug: SEASON_SLUG, cardId } },
    create: {
      cardId,
      seasonSlug: SEASON_SLUG,
      leagueId,
      leagueName,
      level: isDraftPass ? "Unknown" : level,
      ownerWallet,
      status: isDraftPass ? "draft_pass" : "active",
    },
    update: {
      ownerWallet,
      status: isDraftPass ? "draft_pass" : "active",
    },
  });

  // Roster slots power the exposure page (src/app/exposure) — see the same
  // comment in sync-collection.ts. Assumed immutable once drafted, so
  // insert-only (skipDuplicates), and safe to backfill on a re-run even for
  // a season we already imported once without roster data.
  if (!isDraftPass) {
    const roster = getRosterSlots(nft);
    if (roster.length > 0) {
      await prisma.rosterSlot.createMany({
        data: roster.map((r) => ({
          seasonSlug: SEASON_SLUG,
          teamCardId: cardId,
          slot: r.slot,
          value: r.value,
        })),
        skipDuplicates: true,
      });
    }
  }

  // Write ONE final score snapshot from whatever's frozen in the traits —
  // there's no gameweek-by-gameweek history available for a season that's
  // already over, just this last known state.
  if (!isDraftPass) {
    const weeklyScore = parseFinalNumber(traitValue(nft, "WEEK-SCORE"));
    const seasonScore = parseFinalNumber(traitValue(nft, "SEASON-SC0RE")); // typo preserved from source
    const rankRaw = traitValue(nft, "RANK");
    const rank = rankRaw != null && String(rankRaw).toUpperCase() !== "N/A" ? Number(rankRaw) : null;
    if (seasonScore != null) {
      await prisma.scoreSnapshot.upsert({
        where: {
          seasonSlug_teamCardId_gameweek: {
            seasonSlug: SEASON_SLUG,
            teamCardId: cardId,
            gameweek: FINAL_GAMEWEEK,
          },
        },
        create: {
          seasonSlug: SEASON_SLUG,
          teamCardId: cardId,
          gameweek: FINAL_GAMEWEEK,
          rank,
          weeklyScore: weeklyScore ?? 0,
          seasonScore,
        },
        update: { rank, weeklyScore: weeklyScore ?? 0, seasonScore },
      });
    }
  }

  return isDraftPass ? "draft-pass" : "team";
}

async function main() {
  console.log(`[import-season] seeding season "${SEASON_SLUG}" (${SEASON_CHAIN}:${SEASON_CONTRACT})`);
  await prisma.season.upsert({
    where: { slug: SEASON_SLUG },
    create: {
      slug: SEASON_SLUG,
      name: SEASON_NAME,
      chain: SEASON_CHAIN,
      contract: SEASON_CONTRACT,
      isActive: false, // a historical import is never the live/default season
    },
    update: { name: SEASON_NAME, chain: SEASON_CHAIN, contract: SEASON_CONTRACT },
  });

  const log = await prisma.syncLog.create({ data: { source: "opensea-season-import" } });
  const counts = { team: 0, "draft-pass": 0, missing: 0, "no-owner": 0, errors: 0 };

  try {
    let nextId = 1;
    async function worker() {
      while (nextId <= MAX_TOKEN_ID) {
        const tokenId = nextId++;
        let attempt = 0;
        for (;;) {
          try {
            const result = await upsertToken(tokenId);
            counts[result]++;
            break;
          } catch (err: any) {
            attempt++;
            if (err?.rateLimited && attempt <= 5) {
              await new Promise((r) => setTimeout(r, 1000 * attempt));
              continue;
            }
            const isUniqueConstraintRace =
              err?.code === "P2002" || /Unique constraint failed/i.test(String(err));
            if (isUniqueConstraintRace && attempt <= 5) {
              await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
              continue;
            }
            counts.errors++;
            console.error(`[import-season] token ${tokenId} failed:`, String(err));
            break;
          }
        }
        if (tokenId % 250 === 0) {
          console.log(
            `[import-season] ...${tokenId}/${MAX_TOKEN_ID} checked (teams=${counts.team}, draft-passes=${counts["draft-pass"]}, errors=${counts.errors})`,
          );
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // Best-effort: resolve display names for wallets that only ever played
    // this season (SBS's user-profile lookup is account-wide, not
    // season-scoped, so this can fill in usernames even for a season we
    // never live-synced).
    const walletsInSeason = await prisma.team.findMany({
      where: { seasonSlug: SEASON_SLUG },
      select: { ownerWallet: true },
      distinct: ["ownerWallet"],
    });
    const wallets = walletsInSeason.map((w) => w.ownerWallet);
    console.log(`[import-season] resolving display names for ${wallets.length} owners...`);
    const BATCH = 50;
    let profilesResolved = 0;
    for (let i = 0; i < wallets.length; i += BATCH) {
      try {
        const profiles = await getUserProfiles(wallets.slice(i, i + BATCH));
        for (const [wallet, profile] of Object.entries(profiles)) {
          if (!profile?.displayName) continue;
          await prisma.owner.updateMany({
            where: { wallet, displayName: null },
            data: {
              displayName: profile.displayName,
              imageUrl: profile.imageUrl ?? undefined,
              equippedBadge: profile.equippedBadge ?? undefined,
            },
          });
          profilesResolved++;
        }
      } catch (err) {
        console.error("[import-season] profile batch failed (non-fatal):", String(err));
      }
    }
    console.log(`[import-season] resolved ${profilesResolved} display names.`);

    const total = counts.team + counts["draft-pass"];
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), recordCount: total, ok: true },
    });
    console.log(`[import-season] done.`, counts);
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

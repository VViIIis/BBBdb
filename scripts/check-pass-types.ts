import "dotenv/config";
/**
 * One-off diagnostic for a feature question: can we tell paid drafts apart
 * from promo/wheel-spin free drafts?
 *
 * What we know so far: undrafted "Draft Pass" tokens carry a "Pass Type"
 * trait (observed value: "Paid" on one sample). What we DON'T know yet:
 *   1. What the full set of Pass Type values is (just "Paid", or also
 *      "Free"/"Promo"/"Wheel Spin"/etc?).
 *   2. Whether that trait survives once a pass is drafted into a full team
 *      — the one revealed team we've inspected (#7304) did NOT have a Pass
 *      Type trait, suggesting it might disappear on reveal, but that's a
 *      sample size of one.
 *   3. As a fallback if it doesn't survive: whether OpenSea's events API
 *      exposes the original mint transaction's paid value, which would let
 *      us tell paid vs free even for already-revealed teams.
 *
 * Run with: npx tsx scripts/check-pass-types.ts
 */
import { prisma } from "../src/lib/db";
import { getNftByTokenId, BANANA_BEST_BALL_4_CONTRACT } from "../src/lib/opensea";

const CONTRACT = process.env.OPENSEA_CONTRACT ?? BANANA_BEST_BALL_4_CONTRACT;
const CHAIN = process.env.NFT_CHAIN ?? "base";

function passType(nft: { traits: { trait_type: string; value: string | number }[] } | null) {
  return nft?.traits.find((t) => t.trait_type.toLowerCase() === "pass type")?.value;
}

async function main() {
  // 1. Every currently-undrafted Draft Pass: what Pass Type values exist?
  const draftPasses = await prisma.team.findMany({
    where: { status: "draft_pass" },
    select: { cardId: true },
  });
  console.log(`\n=== Checking ${draftPasses.length} undrafted Draft Pass tokens ===`);
  const counts: Record<string, number> = {};
  for (const t of draftPasses) {
    const nft = await getNftByTokenId(CONTRACT, t.cardId, CHAIN);
    const pt = String(passType(nft) ?? "(none)");
    counts[pt] = (counts[pt] ?? 0) + 1;
  }
  console.log("Pass Type values among undrafted Draft Passes:", counts);

  // 2. Sample of already-drafted teams: does Pass Type survive reveal?
  const sample = await prisma.team.findMany({
    where: { status: "active" },
    take: 15,
    select: { cardId: true },
  });
  console.log(`\n=== Checking ${sample.length} drafted teams for a surviving Pass Type trait ===`);
  for (const t of sample) {
    const nft = await getNftByTokenId(CONTRACT, t.cardId, CHAIN);
    console.log(`  team #${t.cardId}: Pass Type =`, passType(nft) ?? "(not present)");
  }

  // 3. Fallback check: does OpenSea's events endpoint expose the original
  // mint transaction (which would show ETH paid, even post-reveal)?
  const probeId = sample[0]?.cardId;
  if (probeId) {
    console.log(`\n=== Checking OpenSea events endpoint for team #${probeId} ===`);
    const res = await fetch(
      `https://api.opensea.io/api/v2/events/chain/${CHAIN}/contract/${CONTRACT}/nfts/${probeId}?event_type=transfer`,
      { headers: { accept: "application/json", "x-api-key": process.env.OPENSEA_API_KEY! } },
    );
    console.log("status:", res.status);
    console.log(await res.text());
  }
}

main().finally(() => prisma.$disconnect());

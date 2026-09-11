/**
 * Client for OpenSea's official API (v2) — used to enumerate the FULL
 * Banana Best Ball collection (all ~14,040 tokens) regardless of score, and
 * to establish current ownership. This is what makes team lookup complete
 * beyond sbsfantasy.com's top-500-scorer leaderboard cap (see sbsApi.ts).
 *
 * Requires a free API key: https://docs.opensea.io/reference/api-keys
 *
 * VERIFIED against live API responses (2026-09-10) using a real drafted
 * team (card #7304) and real undrafted "Draft Pass" tokens:
 *
 *   - The bulk listing endpoint (`/collection/{slug}/nfts`) returns traits
 *     but NOT ownership — a dead end for this use case.
 *   - The single-NFT endpoint (`/chain/{chain}/contract/{addr}/nfts/{id}`)
 *     returns BOTH full traits AND an `owners` array with the current
 *     wallet — confirmed to match the same wallet sbsfantasy.com's own API
 *     reports for that team. So this script calls that endpoint once per
 *     token id (1..maxTokenId) instead of paging the bulk listing.
 *   - A revealed team's traits include: `Status` ("Team" vs "Draft Pass"
 *     for an unrevealed pass), `Level` (matches our Pro/Hall of
 *     Fame/Jackpot/JackHOF/Founder values exactly), `League #`, `Team #`,
 *     `RANK`, `PRIZES`, `WEEK-SCORE`, and (typo preserved from the source)
 *     `SEASON-SC0RE` — plus per-slot roster traits (QB1, QB2, RB1-RB5,
 *     WR1-4, TE1-3, DST1-2, etc. — NOT a fixed count per team).
 *   - Contract: 0xadf5b9b46616de6d073f226e7b7c532ae2cffb80 on Base.
 */

const OPENSEA_BASE = "https://api.opensea.io/api/v2";
export const BANANA_BEST_BALL_4_CONTRACT = "0xadf5b9b46616de6d073f226e7b7c532ae2cffb80";

function apiKey(): string {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) {
    throw new Error(
      "OPENSEA_API_KEY is not set. Get a free key at https://docs.opensea.io/reference/api-keys",
    );
  }
  return key;
}

export interface OpenSeaTrait {
  trait_type: string;
  value: string | number;
}

export interface OpenSeaNft {
  identifier: string;
  name: string;
  image_url: string;
  opensea_url?: string;
  owners?: { address: string; quantity: number }[];
  traits: OpenSeaTrait[];
}

/** Fetches one token by id. Returns null (not throws) on 404 — some ids in
 * the range may not exist (burned, or supply gaps). Throws on other errors
 * so the sync script's retry logic can distinguish "doesn't exist" from
 * "transient failure, try again". */
export async function getNftByTokenId(
  contract: string,
  tokenId: string,
  chain = "base",
): Promise<OpenSeaNft | null> {
  const res = await fetch(`${OPENSEA_BASE}/chain/${chain}/contract/${contract}/nfts/${tokenId}`, {
    headers: { accept: "application/json", "x-api-key": apiKey() },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (res.status === 429) {
    throw Object.assign(new Error("rate limited"), { rateLimited: true });
  }
  if (!res.ok) {
    throw new Error(`OpenSea API nfts/${tokenId} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { nft: OpenSeaNft };
  return data.nft;
}

export function traitValue(nft: OpenSeaNft, traitType: string): string | number | undefined {
  return nft.traits.find((t) => t.trait_type.toLowerCase() === traitType.toLowerCase())?.value;
}

// Trait names that describe the CARD, not a drafted roster slot. Everything
// else in `nft.traits` is a Team Position slot (QB1, RB2, WR3, DST1, ...) —
// the set/count of slots isn't fixed per team, so we don't hard-code them,
// we just exclude what we know isn't one. Verified against a real drafted
// team (#7304) and real Draft Pass tokens on 2026-09-10.
const NON_ROSTER_TRAITS = new Set(
  [
    "Status",
    "Level",
    "RANK",
    "PRIZES",
    "Team #",
    "League #",
    "WEEK-SCORE",
    "SEASON-SC0RE", // typo preserved from the source data
    "Pass Type",
    "Draft Pass #",
  ].map((s) => s.toLowerCase()),
);

// Rough position priority so a roster table reads QB -> RB -> WR -> TE ->
// DST instead of whatever order OpenSea happens to return traits in. Also
// used (via positionOf below) to group exposure by position — see
// src/app/exposure/page.tsx.
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "DST", "FLEX"];

/** Maps a roster slot label (e.g. "WR3") to its position group ("WR"), for
 * grouping/filtering exposure by position. Falls back to "OTHER" for
 * anything that doesn't match a known prefix. */
export function positionOf(slot: string): string {
  const upper = slot.toUpperCase();
  return POSITION_ORDER.find((p) => upper.startsWith(p)) ?? "OTHER";
}

export interface RosterSlot {
  slot: string; // e.g. "QB1"
  value: string; // e.g. "CHI QB"
}

/** Every drafted Team Position slot on a card, in a stable display order. */
export function getRosterSlots(nft: OpenSeaNft): RosterSlot[] {
  const slots = nft.traits
    .filter((t) => !NON_ROSTER_TRAITS.has(t.trait_type.toLowerCase()))
    .map((t) => ({ slot: t.trait_type, value: String(t.value) }));

  return slots.sort((a, b) => {
    const posOf = (slot: string) => POSITION_ORDER.findIndex((p) => slot.toUpperCase().startsWith(p));
    const pa = posOf(a.slot);
    const pb = posOf(b.slot);
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.slot.localeCompare(b.slot, undefined, { numeric: true });
  });
}

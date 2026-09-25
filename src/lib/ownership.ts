import { prisma } from "@/lib/db";

/**
 * SBS's /api/standings and /api/leaderboard keep reporting a team's SELLER
 * as its owner after a marketplace sale, even though the NFT itself (and
 * SBS's own marketplace NFT endpoint) already shows the buyer. Found
 * 2026-09-17 with Jack's 5 marketplace buys (#12731, #11788, #12046, #2919,
 * #2986). SBS said on 2026-09-25 that they'd fixed it, but re-checking that
 * day /api/standings still returned the seller for all 5 — so whatever SBS
 * fixed hasn't reached the endpoints our syncs read.
 *
 * We already record every sale in the Sale table (OpenSea via syncSales,
 * SBS's own marketplace via syncSbsTrades). So: if the API names someone who
 * has SOLD this team, the API is stale, and the buyer in the team's most
 * recent sale is the real owner. Anyone who never sold the team is left
 * alone, so a later gift or transfer SBS does report correctly is never
 * overridden, and once SBS's fix reaches these endpoints this quietly stops
 * changing anything.
 */
export interface SaleHistory {
  sellers: Set<string>;
  latestBuyer: string;
}

export async function loadSaleHistory(seasonSlug: string): Promise<Map<string, SaleHistory>> {
  const sales = await prisma.sale.findMany({
    where: { seasonSlug },
    orderBy: { occurredAt: "desc" },
    select: { teamCardId: true, fromWallet: true, toWallet: true },
  });
  const byCard = new Map<string, SaleHistory>();
  for (const s of sales) {
    const from = s.fromWallet.toLowerCase();
    const to = s.toWallet.toLowerCase();
    const entry = byCard.get(s.teamCardId);
    if (entry) {
      entry.sellers.add(from);
    } else {
      // First row per card is the most recent sale (ordered desc above).
      byCard.set(s.teamCardId, { sellers: new Set([from]), latestBuyer: to });
    }
  }
  return byCard;
}

/** The real current owner, given what SBS's API reported. */
export function currentOwner(history: Map<string, SaleHistory>, cardId: string, apiOwner: string): string {
  const owner = apiOwner.toLowerCase();
  const h = history.get(cardId);
  if (!h || !h.latestBuyer.startsWith("0x")) return owner;
  if (h.sellers.has(owner) && h.latestBuyer !== owner) return h.latestBuyer;
  return owner;
}

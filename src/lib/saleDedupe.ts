import { prisma } from "@/lib/db";

/**
 * SBS's own marketplace settles trades as Seaport orders on Base, and OpenSea
 * indexes every Seaport fill on Base as a sale. So each trade made on SBS's
 * marketplace was being recorded twice: once by syncSbsTrades.ts
 * (marketplace "sbs") and again by syncSales.ts (marketplace "opensea"). Found
 * 2026-10-08: Sh0resi showed 92 bought / 24 sold on the Trades tab, while
 * SBS's own activity feed has exactly 46 buys / 12 sells. Every SBS trade was
 * counted double in Top traders, Most-traded positions, volume and Recent
 * sales.
 *
 * The SBS record is kept and the OpenSea copy dropped: the trade really
 * happened on SBS's marketplace. Two records are the same trade if they're
 * for the same team and either share a transaction hash or have the same
 * seller and buyer within 5 minutes of each other (the two sources' times
 * differ by under a second in practice).
 */
const TWIN_WINDOW_MS = 5 * 60 * 1000;

/** Is this OpenSea sale already recorded as an SBS-marketplace sale? */
export async function hasSbsTwin(sale: {
  seasonSlug: string;
  teamCardId: string;
  fromWallet: string;
  toWallet: string;
  occurredAt: Date;
  txHash: string | null;
}): Promise<boolean> {
  const t = sale.occurredAt.getTime();
  const twin = await prisma.sale.findFirst({
    where: {
      seasonSlug: sale.seasonSlug,
      teamCardId: sale.teamCardId,
      marketplace: "sbs",
      OR: [
        ...(sale.txHash ? [{ txHash: { equals: sale.txHash, mode: "insensitive" as const } }] : []),
        {
          fromWallet: { equals: sale.fromWallet, mode: "insensitive" as const },
          toWallet: { equals: sale.toWallet, mode: "insensitive" as const },
          occurredAt: { gte: new Date(t - TWIN_WINDOW_MS), lte: new Date(t + TWIN_WINDOW_MS) },
        },
      ],
    },
    select: { id: true },
  });
  return twin != null;
}

/** Deletes OpenSea copies of SBS-marketplace trades for a season. Returns how many were removed. */
export async function removeOpenSeaTwins(seasonSlug: string): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "Sale" o
    USING "Sale" s
    WHERE o."seasonSlug" = ${seasonSlug}
      AND s."seasonSlug" = ${seasonSlug}
      AND o."marketplace" = 'opensea'
      AND s."marketplace" = 'sbs'
      AND o."teamCardId" = s."teamCardId"
      AND (
        (o."txHash" IS NOT NULL AND s."txHash" IS NOT NULL AND lower(o."txHash") = lower(s."txHash"))
        OR (
          lower(o."fromWallet") = lower(s."fromWallet")
          AND lower(o."toWallet") = lower(s."toWallet")
          AND abs(extract(epoch FROM (o."occurredAt" - s."occurredAt"))) <= 300
        )
      )
  `;
}

import Link from "next/link";
import { prisma } from "@/lib/db";
import { positionOf } from "@/lib/opensea";
import SeasonTabs from "@/components/SeasonTabs";
import { getAllSeasons, resolveSeason } from "@/lib/seasons";

export const dynamic = "force-dynamic";

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// Sale prices are stored in whatever currency OpenSea reports for that sale
// (see `paymentSymbol` on the Sale model) — this collection trades in USDC,
// not ETH, so the label has to come from the actual data instead of being
// assumed. `symbol` is optional so a lone value (no aggregation context)
// can still render before we know it.
function formatPrice(n: number | null, symbol?: string | null) {
  if (n == null) return "—";
  return `${n.toFixed(3)}${symbol ? ` ${symbol}` : ""}`;
}

// --- "Most-traded Team Positions" sort ---
type PosSortKey = "value" | "count" | "avgPrice";
const POS_SORT_DEFAULT: Record<PosSortKey, "asc" | "desc"> = {
  value: "asc",
  count: "desc",
  avgPrice: "desc",
};
function isPosSortKey(v: string | undefined): v is PosSortKey {
  return v === "value" || v === "count" || v === "avgPrice";
}

// --- "Top traders" sort ---
type TraderSortKey = "wallet" | "total" | "bought" | "sold" | "ethTotal";
const TRADER_SORT_DEFAULT: Record<TraderSortKey, "asc" | "desc"> = {
  wallet: "asc",
  total: "desc",
  bought: "desc",
  sold: "desc",
  ethTotal: "desc",
};
function isTraderSortKey(v: string | undefined): v is TraderSortKey {
  return v === "wallet" || v === "total" || v === "bought" || v === "sold" || v === "ethTotal";
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: {
    season?: string;
    posSort?: string;
    posDir?: string;
    traderSort?: string;
    traderDir?: string;
  };
}) {
  const [season, seasons] = await Promise.all([
    resolveSeason(searchParams.season),
    getAllSeasons(),
  ]);

  const posSortKey: PosSortKey = isPosSortKey(searchParams.posSort) ? searchParams.posSort : "count";
  const posDir: "asc" | "desc" =
    searchParams.posDir === "asc" || searchParams.posDir === "desc"
      ? searchParams.posDir
      : POS_SORT_DEFAULT[posSortKey];

  const traderSortKey: TraderSortKey = isTraderSortKey(searchParams.traderSort)
    ? searchParams.traderSort
    : "total";
  const traderDir: "asc" | "desc" =
    searchParams.traderDir === "asc" || searchParams.traderDir === "desc"
      ? searchParams.traderDir
      : TRADER_SORT_DEFAULT[traderSortKey];

  function posSortHref(column: PosSortKey) {
    const params = new URLSearchParams();
    params.set("season", season.slug);
    if (searchParams.traderSort) params.set("traderSort", searchParams.traderSort);
    if (searchParams.traderDir) params.set("traderDir", searchParams.traderDir);
    params.set("posSort", column);
    params.set(
      "posDir",
      column === posSortKey && posDir === POS_SORT_DEFAULT[column]
        ? posDir === "asc" ? "desc" : "asc"
        : POS_SORT_DEFAULT[column],
    );
    return `/trades?${params.toString()}`;
  }
  function posSortIndicator(column: PosSortKey) {
    if (column !== posSortKey) return null;
    return <span className="ml-1 text-banana-400">{posDir === "asc" ? "▲" : "▼"}</span>;
  }

  function traderSortHref(column: TraderSortKey) {
    const params = new URLSearchParams();
    params.set("season", season.slug);
    if (searchParams.posSort) params.set("posSort", searchParams.posSort);
    if (searchParams.posDir) params.set("posDir", searchParams.posDir);
    params.set("traderSort", column);
    params.set(
      "traderDir",
      column === traderSortKey && traderDir === TRADER_SORT_DEFAULT[column]
        ? traderDir === "asc" ? "desc" : "asc"
        : TRADER_SORT_DEFAULT[column],
    );
    return `/trades?${params.toString()}`;
  }
  function traderSortIndicator(column: TraderSortKey) {
    if (column !== traderSortKey) return null;
    return <span className="ml-1 text-banana-400">{traderDir === "asc" ? "▲" : "▼"}</span>;
  }

  if (!season.collectionSlug) {
    return (
      <main>
        <h1 className="mb-1 text-2xl font-bold">Trades</h1>
        <div className="mb-4">
          <SeasonTabs seasons={seasons} current={season.slug} basePath="/trades" />
        </div>
        <p className="text-sm text-zinc-500">
          Marketplace sales tracking isn&rsquo;t set up for {season.name} (no OpenSea collection
          configured for it) — see {season.name === "Banana Best Ball IV" ? "the active" : "another"}{" "}
          season instead.
        </p>
      </main>
    );
  }

  const [lastSync, sales] = await Promise.all([
    prisma.syncLog.findFirst({
      where: { source: "opensea-sales", ok: true },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.sale.findMany({
      where: { seasonSlug: season.slug },
      orderBy: { occurredAt: "desc" },
      include: { team: true },
    }),
  ]);

  const recentSales = sales.slice(0, 50);

  const walletsToLookUp = new Set<string>();
  for (const s of recentSales) {
    walletsToLookUp.add(s.fromWallet);
    walletsToLookUp.add(s.toWallet);
  }

  // Aggregated tables (positions, traders) sum across many sales into one
  // number, so they need ONE label rather than a per-row symbol. In
  // practice this collection trades in a single currency, so "whatever
  // shows up most often" is a safe stand-in for "the" currency; if that
  // ever stops being true, the per-sale symbol in the recent-sales feed
  // below is still accurate regardless.
  const symbolCounts = new Map<string, number>();
  for (const s of sales) {
    if (s.paymentSymbol) symbolCounts.set(s.paymentSymbol, (symbolCounts.get(s.paymentSymbol) ?? 0) + 1);
  }
  const dominantSymbol = [...symbolCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // --- "Most-traded Team Positions": expand each sale to every Team
  // Position the sold team carries, and count how many sale events involved
  // a team holding that value. Same unit exposure uses (a Team Position,
  // not a real player — see /exposure), just measured by trade activity
  // instead of holdings. ---
  const cardIds = [...new Set(sales.map((s) => s.teamCardId))];
  const rosterRows =
    cardIds.length > 0
      ? await prisma.rosterSlot.findMany({
          where: { seasonSlug: season.slug, teamCardId: { in: cardIds } },
          select: { teamCardId: true, value: true, slot: true },
        })
      : [];
  const rosterByTeam = new Map<string, { value: string; slot: string }[]>();
  for (const r of rosterRows) {
    if (!rosterByTeam.has(r.teamCardId)) rosterByTeam.set(r.teamCardId, []);
    rosterByTeam.get(r.teamCardId)!.push(r);
  }

  const posStats = new Map<string, { position: string; count: number; sumPrice: number; priceCount: number }>();
  for (const s of sales) {
    const slots = rosterByTeam.get(s.teamCardId) ?? [];
    for (const slot of slots) {
      const entry = posStats.get(slot.value) ?? {
        position: positionOf(slot.slot),
        count: 0,
        sumPrice: 0,
        priceCount: 0,
      };
      entry.count += 1;
      if (s.priceEth != null) {
        entry.sumPrice += s.priceEth;
        entry.priceCount += 1;
      }
      posStats.set(slot.value, entry);
    }
  }
  const posRows = [...posStats.entries()]
    .map(([value, s]) => ({
      value,
      position: s.position,
      count: s.count,
      avgPrice: s.priceCount > 0 ? s.sumPrice / s.priceCount : null,
    }))
    .sort((a, b) => {
      if (posSortKey === "value") {
        return posDir === "asc" ? a.value.localeCompare(b.value) : b.value.localeCompare(a.value);
      }
      const av = posSortKey === "count" ? a.count : a.avgPrice ?? -1;
      const bv = posSortKey === "count" ? b.count : b.avgPrice ?? -1;
      return posDir === "asc"
        ? av - bv || a.value.localeCompare(b.value)
        : bv - av || a.value.localeCompare(b.value);
    })
    .slice(0, 25);

  // --- "Top traders": every wallet that's appeared as a buyer and/or
  // seller, ranked by total transactions. ---
  const traderStats = new Map<
    string,
    { bought: number; sold: number; ethBought: number; ethSold: number }
  >();
  for (const s of sales) {
    const seller = traderStats.get(s.fromWallet) ?? { bought: 0, sold: 0, ethBought: 0, ethSold: 0 };
    seller.sold += 1;
    seller.ethSold += s.priceEth ?? 0;
    traderStats.set(s.fromWallet, seller);

    const buyer = traderStats.get(s.toWallet) ?? { bought: 0, sold: 0, ethBought: 0, ethSold: 0 };
    buyer.bought += 1;
    buyer.ethBought += s.priceEth ?? 0;
    traderStats.set(s.toWallet, buyer);

    walletsToLookUp.add(s.fromWallet);
    walletsToLookUp.add(s.toWallet);
  }
  const traderRowsAll = [...traderStats.entries()].map(([wallet, s]) => ({
    wallet,
    bought: s.bought,
    sold: s.sold,
    total: s.bought + s.sold,
    ethTotal: s.ethBought + s.ethSold,
  }));
  const traderRows = traderRowsAll
    .sort((a, b) => {
      if (traderSortKey === "wallet") return traderDir === "asc" ? 0 : 0; // wallets have no natural alpha identity beyond the address; not a useful sort target, kept for completeness
      const av = a[traderSortKey];
      const bv = b[traderSortKey];
      return traderDir === "asc" ? av - bv : bv - av;
    })
    .slice(0, 25);
  for (const r of traderRows) walletsToLookUp.add(r.wallet);

  const owners = await prisma.owner.findMany({ where: { wallet: { in: [...walletsToLookUp] } } });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet, o]));
  function ownerLabel(wallet: string) {
    return ownerByWallet.get(wallet)?.displayName ?? shortWallet(wallet);
  }

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Trades</h1>
      <p className="mb-4 text-sm text-zinc-400">
        {season.name}
        {lastSync ? ` · last synced ${lastSync.finishedAt!.toLocaleString()}` : " · no sales synced yet"}
        {" — "}marketplace sale activity: what&rsquo;s being traded, and by whom.
      </p>

      <div className="mb-6">
        <SeasonTabs seasons={seasons} current={season.slug} basePath="/trades" />
      </div>

      {sales.length === 0 && (
        <p className="text-sm text-zinc-500">
          No sales synced yet for {season.name}. Once <code>npm run sync:sales</code> has run at least
          once (see <code>.github/workflows/sync-sales.yml</code>), trade activity will show up here.
        </p>
      )}

      {sales.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold">Most-traded Team Positions</h2>
          <p className="mb-3 text-sm text-zinc-400">
            How often a team holding each Team Position has changed hands — same unit as{" "}
            <Link href="/exposure" className="hover:text-banana-400">
              Exposure
            </Link>
            , measured by trade activity instead of holdings.
          </p>
          <div className="mb-8 overflow-x-auto rounded-lg border border-ink-600">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="bg-ink-800 text-zinc-400">
                <tr>
                  <th className="px-3 py-2">
                    <Link href={posSortHref("value")} className="hover:text-banana-400">
                      Team Position{posSortIndicator("value")}
                    </Link>
                  </th>
                  <th className="px-3 py-2">Pos</th>
                  <th className="px-3 py-2 text-right">
                    <Link href={posSortHref("count")} className="hover:text-banana-400">
                      Sales{posSortIndicator("count")}
                    </Link>
                  </th>
                  <th className="px-3 py-2 text-right">
                    <Link href={posSortHref("avgPrice")} className="hover:text-banana-400">
                      Avg price{dominantSymbol ? ` (${dominantSymbol})` : ""}{posSortIndicator("avgPrice")}
                    </Link>
                  </th>
                </tr>
              </thead>
              <tbody>
                {posRows.map((r) => (
                  <tr key={r.value} className="border-t border-ink-600">
                    <td className="px-3 py-2 font-medium">{r.value}</td>
                    <td className="px-3 py-2 text-zinc-400">{r.position}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.count}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {formatPrice(r.avgPrice)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mb-2 text-lg font-semibold">Top traders</h2>
          <p className="mb-3 text-sm text-zinc-400">Every wallet ranked by total buys + sells.</p>
          <div className="mb-8 overflow-x-auto rounded-lg border border-ink-600">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="bg-ink-800 text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2 text-right">
                    <Link href={traderSortHref("bought")} className="hover:text-banana-400">
                      Bought{traderSortIndicator("bought")}
                    </Link>
                  </th>
                  <th className="px-3 py-2 text-right">
                    <Link href={traderSortHref("sold")} className="hover:text-banana-400">
                      Sold{traderSortIndicator("sold")}
                    </Link>
                  </th>
                  <th className="px-3 py-2 text-right">
                    <Link href={traderSortHref("total")} className="hover:text-banana-400">
                      Total{traderSortIndicator("total")}
                    </Link>
                  </th>
                  <th className="px-3 py-2 text-right">
                    <Link href={traderSortHref("ethTotal")} className="hover:text-banana-400">
                      Volume{dominantSymbol ? ` (${dominantSymbol})` : ""}{traderSortIndicator("ethTotal")}
                    </Link>
                  </th>
                </tr>
              </thead>
              <tbody>
                {traderRows.map((r) => (
                  <tr key={r.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                    <td className="px-3 py-2">
                      <Link href={`/owner/${r.wallet}`} className="hover:text-banana-400">
                        {ownerLabel(r.wallet)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{r.bought}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.sold}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{r.total}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-400">
                      {formatPrice(r.ethTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mb-2 text-lg font-semibold">Recent sales</h2>
          <div className="overflow-x-auto rounded-lg border border-ink-600">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-ink-800 text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">To</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((s) => (
                  <tr key={s.id} className="border-t border-ink-600 hover:bg-ink-800/60">
                    <td className="px-3 py-2">
                      <Link
                        href={`/team/${season.slug}/${s.teamCardId}`}
                        className="hover:text-banana-400"
                      >
                        {s.team.leagueName} · #{s.teamCardId}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/owner/${s.fromWallet}`} className="text-zinc-400 hover:text-banana-400">
                        {ownerLabel(s.fromWallet)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/owner/${s.toWallet}`} className="hover:text-banana-400">
                        {ownerLabel(s.toWallet)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {formatPrice(s.priceEth, s.paymentSymbol)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-500">
                      {s.occurredAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

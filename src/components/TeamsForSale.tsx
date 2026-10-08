import Link from "@/components/Link";
import { prisma } from "@/lib/db";
import { getMarketplaceListings, SbsListing } from "@/lib/sbsApi";
import { getCollectionBestListings, OpenSeaListing } from "@/lib/opensea";
import { getPodRanks, podRankByCardId, ordinal, PodKey } from "@/lib/advancement";

/**
 * "Teams for sale" on the Trades tab: search live marketplace listings — SBS's
 * own marketplace AND OpenSea — by team position. The use case: BUF QB just
 * had a big game, so show every team for sale that has BUF QB on its
 * roster, cheapest first.
 *
 * Matching (case-insensitive), against each team's roster of team positions
 * like "BUF QB" / "BUF WR1":
 *   "BUF QB"  -> exactly that position
 *   "BUF WR"  -> BUF WR1 and BUF WR2
 *   "BUF"     -> any Buffalo position
 * Several positions separated by commas must ALL be on the team
 * ("BUF QB, BUF WR1" finds stacks).
 *
 * SBS's marketplace orders are Seaport orders too, so the same order can
 * show up on both — matched by order hash and shown once, as an SBS
 * listing. A team listed separately on each market (two different orders)
 * shows twice, once per market, since the prices can differ.
 */

const SHOWN_WITHOUT_SEARCH = 10;
const MAX_RESULTS = 100;
const DOLLAR_CURRENCIES = new Set(["USDC", "USDBC", "USDT", "DAI"]);

interface ForSale {
  key: string;
  tokenId: string;
  market: "SBS" | "OpenSea";
  price: number;
  currency: string;
  sellerAddress: string;
  sellerName: string | null;
  roster: string[];
  points: number | null;
  draftType: string | null; // SBS's "pro" | "hof" | "jackpot", when known
  buyUrl: string;
}

function parseQuery(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase().replace(/\s+/g, " "))
    .filter(Boolean);
}

function matchesTerm(position: string, term: string): boolean {
  const p = position.toUpperCase();
  if (p === term) return true;
  if (!term.includes(" ")) return p.startsWith(`${term} `); // team only: "BUF"
  return p.startsWith(term); // "BUF WR" -> BUF WR1 / BUF WR2
}

function levelLabel(dbLevel: string | undefined, draftType: string | null): string {
  if (dbLevel) return dbLevel === "Hall of Fame" ? "HOF" : dbLevel;
  if (draftType === "hof") return "HOF";
  if (draftType === "jackpot") return "Jackpot";
  return "Pro";
}

function formatPrice(price: number, currency: string): string {
  if (DOLLAR_CURRENCIES.has(currency)) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${price.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`;
}

function shortWallet(wallet: string) {
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "—";
}

export default async function TeamsForSale({
  seasonSlug,
  chain,
  contract,
  collectionSlug,
  query,
  season,
}: {
  seasonSlug: string;
  chain: string;
  contract: string;
  collectionSlug: string | null;
  query: string | undefined;
  /** the page's ?season= param, kept on the search form */
  season: string | undefined;
}) {
  const [sbsResult, osResult] = await Promise.allSettled([
    getMarketplaceListings(),
    collectionSlug ? getCollectionBestListings(collectionSlug) : Promise.resolve([] as OpenSeaListing[]),
  ]);
  const sbs: SbsListing[] = sbsResult.status === "fulfilled" ? sbsResult.value : [];
  const os: OpenSeaListing[] = osResult.status === "fulfilled" ? osResult.value : [];
  const sbsFailed = sbsResult.status === "rejected";
  const osFailed = osResult.status === "rejected" || !collectionSlug;

  const sbsOrders = new Set(sbs.map((l) => l.orderHash).filter(Boolean));
  const osOnly = os.filter((l) => !l.orderHash || !sbsOrders.has(l.orderHash));

  // OpenSea listings don't carry a roster or score — fill those in from our
  // own data (RosterSlot / latest ScoreSnapshot / Owner), keyed by token id.
  const osTeams = osOnly.length
    ? await prisma.team.findMany({
        where: { seasonSlug, cardId: { in: [...new Set(osOnly.map((l) => l.tokenId))] } },
        select: {
          cardId: true,
          rosterSlots: { select: { value: true } },
          scores: { orderBy: { capturedAt: "desc" }, take: 1, select: { seasonScore: true } },
        },
      })
    : [];
  const osTeamByCard = new Map(osTeams.map((t) => [t.cardId, t]));
  const osSellers = osOnly.length
    ? await prisma.owner.findMany({
        where: { wallet: { in: [...new Set(osOnly.map((l) => l.seller).filter(Boolean))] } },
        select: { wallet: true, displayName: true },
      })
    : [];
  const sellerName = new Map(osSellers.map((o) => [o.wallet, o.displayName]));

  const all: ForSale[] = [
    ...sbs.map(
      (l): ForSale => ({
        key: `sbs-${l.tokenId}-${l.orderHash}`,
        tokenId: l.tokenId,
        market: "SBS",
        price: l.price,
        currency: "USDC",
        sellerAddress: l.ownerAddress,
        sellerName: l.owner || null,
        roster: l.roster,
        points: l.points,
        draftType: l.draftType,
        buyUrl: `https://sbsfantasy.com/marketplace/${l.tokenId}`,
      }),
    ),
    ...osOnly.map((l): ForSale => {
      const t = osTeamByCard.get(l.tokenId);
      return {
        key: `os-${l.tokenId}-${l.orderHash}`,
        tokenId: l.tokenId,
        market: "OpenSea",
        price: l.price,
        currency: l.currency,
        sellerAddress: l.seller,
        sellerName: sellerName.get(l.seller) ?? null,
        roster: t?.rosterSlots.map((r) => r.value) ?? [],
        points: t?.scores[0]?.seasonScore ?? null,
        draftType: null,
        buyUrl: `https://opensea.io/assets/${chain}/${contract}/${l.tokenId}`,
      };
    }),
  ].sort((a, b) => {
    // Dollar-priced listings first, cheapest first; anything priced in ETH
    // etc. after them (no exchange rate here to compare the two).
    const da = DOLLAR_CURRENCIES.has(a.currency) ? 0 : 1;
    const db = DOLLAR_CURRENCIES.has(b.currency) ? 0 : 1;
    return da - db || a.price - b.price;
  });

  const terms = parseQuery(query);
  const matches = terms.length ? all.filter((l) => terms.every((t) => l.roster.some((pos) => matchesTerm(pos, t)))) : all;
  const shown = matches.slice(0, terms.length ? MAX_RESULTS : SHOWN_WITHOUT_SEARCH);

  // Autocomplete list: every team position on any listed team.
  const allPositions = [...new Set(all.flatMap((l) => l.roster))].sort();

  // Level + pod standing from our own data, same as the rest of the site.
  const teams = shown.length
    ? await prisma.team.findMany({
        where: { seasonSlug, cardId: { in: [...new Set(shown.map((l) => l.tokenId))] } },
        select: { cardId: true, level: true, leagueName: true },
      })
    : [];
  const teamByCard = new Map(teams.map((t) => [t.cardId, t]));
  const podKeys: PodKey[] = [];
  const seenPods = new Set<string>();
  for (const t of teams) {
    const key = `${t.level}::${t.leagueName}`;
    if (!seenPods.has(key)) {
      seenPods.add(key);
      podKeys.push({ level: t.level, leagueName: t.leagueName });
    }
  }
  const podRank = podRankByCardId(await getPodRanks(seasonSlug, podKeys));

  const sbsCount = all.filter((l) => l.market === "SBS").length;
  const osCount = all.length - sbsCount;

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-lg font-semibold">Teams for sale</h2>
      <p className="mb-3 text-sm text-zinc-400">
        Live from SBS&rsquo;s marketplace and OpenSea ({sbsCount} on SBS, {osCount} on OpenSea). Search by team
        position to find every team for sale that has it — e.g. <span className="font-mono text-zinc-300">BUF QB</span>,{" "}
        <span className="font-mono text-zinc-300">BUF WR</span>, just <span className="font-mono text-zinc-300">BUF</span>,
        or a stack like <span className="font-mono text-zinc-300">BUF QB, BUF WR1</span>.
      </p>

      <form action="/trades" method="GET" className="mb-3 flex gap-2 sm:max-w-md">
        {season && <input type="hidden" name="season" value={season} />}
        <input
          type="text"
          name="pos"
          list="for-sale-positions"
          defaultValue={query ?? ""}
          placeholder="Team position, e.g. BUF QB"
          autoComplete="off"
          className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
        />
        <datalist id="for-sale-positions">
          {allPositions.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <button type="submit" className="shrink-0 rounded-lg bg-banana-400 px-3 py-2 text-sm font-semibold text-ink-900">
          Search
        </button>
        {terms.length > 0 && (
          <Link
            href={season ? `/trades?season=${encodeURIComponent(season)}` : "/trades"}
            className="shrink-0 self-center text-sm text-zinc-500 hover:text-banana-400"
          >
            Clear
          </Link>
        )}
      </form>

      {(sbsFailed || (osFailed && collectionSlug)) && (
        <p className="mb-2 text-xs text-zinc-500">
          {sbsFailed && "SBS's marketplace didn't respond, so its listings are missing. "}
          {osFailed && collectionSlug && "OpenSea didn't respond, so its listings are missing. "}
          Try again in a minute.
        </p>
      )}

      <p className="mb-2 text-xs text-zinc-500">
        {terms.length
          ? `${matches.length} listing${matches.length === 1 ? "" : "s"} with ${terms.join(" + ")}${
              matches.length > shown.length ? ` (showing the ${shown.length} cheapest)` : ""
            }, cheapest first.`
          : `Cheapest ${shown.length} of ${all.length} listed. Search above to filter by position.`}
      </p>
      <div className="overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full text-left text-sm sm:min-w-[620px]">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-2 py-2 sm:px-3">Team</th>
              <th className="px-2 py-2 sm:px-3">Pod</th>
              <th className="px-2 py-2 text-right sm:px-3">Season</th>
              <th className="px-2 py-2 text-right sm:px-3">Price</th>
              <th className="hidden px-2 py-2 sm:table-cell sm:px-3">Seller</th>
              <th className="px-2 py-2 sm:px-3" />
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const t = teamByCard.get(l.tokenId);
              const pr = podRank.get(l.tokenId);
              const hits = terms.length ? l.roster.filter((pos) => terms.some((term) => matchesTerm(pos, term))) : [];
              return (
                <tr key={l.key} className="border-t border-ink-600 align-top hover:bg-ink-800/60">
                  <td className="px-2 py-2 sm:px-3">
                    <Link href={`/team/${seasonSlug}/${l.tokenId}`} className="hover:text-banana-400">
                      #{l.tokenId}
                    </Link>
                    <span className="ml-1.5 text-xs text-zinc-500">{levelLabel(t?.level, l.draftType)}</span>
                    {hits.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {hits.map((h) => (
                          <span
                            key={h}
                            className="rounded-full bg-banana-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-banana-400"
                          >
                            {h}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 sm:px-3">
                    {pr?.podRank != null ? (
                      <span className={pr.advancing ? "text-banana-400" : "text-zinc-400"}>
                        {ordinal(pr.podRank)}/{pr.podSize}
                        {pr.advancing && " ↑"}
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono sm:px-3">
                    {l.points != null ? l.points.toFixed(2) : "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono font-semibold sm:px-3">
                    {formatPrice(l.price, l.currency)}
                  </td>
                  <td className="hidden px-2 py-2 text-zinc-400 sm:table-cell sm:px-3">
                    {l.sellerAddress ? (
                      <Link href={`/owner/${l.sellerAddress}`} className="hover:text-banana-400">
                        {l.sellerName || shortWallet(l.sellerAddress)}
                      </Link>
                    ) : (
                      l.sellerName || "—"
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right sm:px-3">
                    <a
                      href={l.buyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-400 hover:text-banana-400"
                    >
                      Buy on {l.market} →
                    </a>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  {terms.length ? `No teams for sale with ${terms.join(" + ")} right now.` : "Nothing listed right now."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

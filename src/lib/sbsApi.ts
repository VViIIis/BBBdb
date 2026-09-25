/**
 * Client for sbsfantasy.com's own public JSON API.
 *
 * This is NOT a documented/official API — it's the same endpoint the
 * sbsfantasy.com frontend calls to render its own leaderboard page, discovered
 * by inspecting network requests. It requires no auth and no API key. Two
 * things to respect if you build on this:
 *
 *   1. It's undocumented, so SBS can change the response shape or block it
 *      at any time without notice. Keep the sync job resilient (log + skip
 *      on failure, don't crash) and re-check field names occasionally.
 *   2. Be a good citizen: this project only reads public leaderboard data
 *      that SBS already shows to anonymous visitors, and the sync script
 *      polls on a schedule (e.g. hourly), not in a tight loop. Don't hammer
 *      it — a few requests every sync run is plenty.
 *
 * CONFIRMED LIMITATION: /api/leaderboard caps out at 500 rows per call and
 * ignores offset/page/cursor params (tested). That means this endpoint gives
 * you the top 500 teams per (level, gameweek) — plenty for a "global top
 * scorers" leaderboard, but NOT full score coverage for every team (a team
 * has to crack a global top-500 pull to ever get a ScoreSnapshot at all).
 * For a complete "look up any team" database of WHO OWNS what, pair this
 * with scripts/sync-collection.ts (OpenSea), which enumerates every token in
 * the collection regardless of score. For complete SCORE coverage (every
 * team's actual weekly/season score, not just the leaderboard-toppers), see
 * getFullStandings() below and scripts/sync-standings.ts, which walks
 * per-pod standings instead of the capped global leaderboard.
 */

const BASE_URL = "https://sbsfantasy.com";

// Values observed in the "All / Pro / HOF / Jackpot / JackHOF" tabs on
// sbsfantasy.com/teams. "all" is what the site itself defaults to; the
// individual level query values are unconfirmed for the API (the UI tabs may
// filter client-side) — sync script defaults to pulling "all" and grouping
// by the `level` field in each returned row instead of relying on a level
// query param.
export const KNOWN_LEVELS = ["Pro", "Hall of Fame", "Jackpot", "JackHOF", "Founder"] as const;
export type SbsLevel = (typeof KNOWN_LEVELS)[number];

export interface SbsLeaderboardRow {
  rank: number;
  username: string;
  teamName: string; // e.g. "BBB #687 · #7304"
  seasonScore: number;
  weeklyScore: number;
  isCurrentUser: boolean;
  ownerWallet: string;
  leagueId: string; // e.g. "2026-fast-draft-606" — the 10-team pod
  leagueName: string; // e.g. "BBB #687"
  cardId: string; // e.g. "7304" — matches the NFT token id
  level: string;
}

/**
 * `/api/leaderboard`'s top-500 cap (above) means a wallet's lower-scoring
 * teams — most of them, for anyone without a top-of-the-global-board team —
 * never show up anywhere on the site built from that endpoint alone. This is
 * exactly why an owner page could show "Teams: 71, Scored teams: 6": only
 * the 6 good enough to crack a global top-500 pull ever got a ScoreSnapshot.
 *
 * The fix: sbsfantasy.com also runs `/api/standings?wallet=...&draftId=...`
 * per POD (10-team league), which returns EVERY team in that pod regardless
 * of global rank — confirmed by fetching known low-scoring pods directly.
 * `wallet` can be the zero address; it only affects an `isCurrentUser`-style
 * flag we don't use. Discovered by inspecting sbsfantasy.com's own network
 * requests, same methodology as the rest of this file.
 *
 * `draftId` follows the pattern `{year}-{speed}-draft-{n}` and isn't
 * contiguous or documented anywhere, so scripts/sync-standings.ts just walks
 * every `n` up to these bounds and skips the (common, harmless) misses —
 * mirrors sync-collection.ts's tolerant token-id walk. Bounds were found by
 * live-probing sbsfantasy.com on 2026-09-14 (highest confirmed valid n in
 * parens) with headroom added; re-raise them if BBB IV keeps adding pods:
 *   - 2026-slow-draft- : up to 168 -> DRAFT_ID_RANGES uses 200
 *   - 2026-fast-draft- : up to 1207 -> DRAFT_ID_RANGES uses 1250
 *   - 2025-slow-draft- : up to 92 (legacy pods still queryable, e.g. old
 *     JackHOF/Promo/Wheel/Banana-Race leagues) -> DRAFT_ID_RANGES uses 150
 *   - 2025-fast-draft- : none found from 1-200 or at any power of 2 up to
 *     4096 — omitted entirely (doesn't seem to exist).
 */
export const DRAFT_ID_RANGES: { prefix: string; max: number }[] = [
  { prefix: "2026-slow-draft-", max: 200 },
  { prefix: "2026-fast-draft-", max: 1250 },
  { prefix: "2025-slow-draft-", max: 150 },
];

/** One row of a pod's full standings, as returned per-entry by getFullStandings(). */
export interface SbsStandingsRow {
  cardId: string;
  ownerWallet: string;
  level: string;
  leagueId: string; // e.g. "2026-slow-draft-1"
  leagueName: string; // e.g. "BBB #17"
  rank: number | null; // global rank
  weeklyScore: number;
  seasonScore: number;
}

/**
 * Full standings for ONE pod (~10 teams), regardless of global rank. Returns
 * `[]` for a draftId that doesn't exist or has no standings yet (this is the
 * common case while walking a padded id range — not an error).
 */
export async function getFullStandings(gameweek: string, draftId: string): Promise<SbsStandingsRow[]> {
  const data = await getJson<{ leaderboard?: any[] }>(
    `/api/standings?wallet=0x0000000000000000000000000000000000000000&draftId=${encodeURIComponent(draftId)}&gameweek=${encodeURIComponent(gameweek)}&orderBy=scoreSeason`,
  );
  const entries = data?.leaderboard ?? [];
  return entries
    .map((e): SbsStandingsRow | null => {
      // card.realTokenId FIRST, not _cardId: for legacy 2025-slow-draft-
      // pods (JackHOF/HOF "from Promo"/"from Wheel"/"from Banana Race"
      // picks), `_cardId` is a synthetic per-pick id like
      // "special-1788005018303-966d3b" — NOT the NFT token id our Team
      // rows are keyed by. Those entries carry the real token id
      // separately as `card.realTokenId` (confirmed live on
      // 2026-09-14: draftId 2025-slow-draft-65's rank-1 entry had
      // `_cardId: "special-1788005018303-966d3b"` and
      // `card.realTokenId: "11089"`, matching the "· #11089" shown in
      // the site's own UI). A normal (non-special) pick has no
      // `realTokenId` at all and `_cardId` already IS the real token id,
      // so this falls back correctly for every other pod.
      //
      // Getting this wrong (as an earlier version of this function did)
      // doesn't drop these teams from the walk — the pod is still
      // fetched and a row is still built — it just writes the score
      // under the WRONG cardId, creating a phantom Team row that never
      // matches the real, OpenSea-sourced Team row for that token. The
      // real team then permanently shows no score even though this
      // endpoint has one. See syncStandings.ts's end-of-run cleanup,
      // which removes the phantom "special-*" rows this bug produced
      // before this fix.
      const cardId = e?.card?.realTokenId ?? e?._cardId ?? e?.card?._cardId;
      const ownerWallet = e?.ownerId ?? e?.card?._ownerId;
      const leagueId = e?.card?._leagueId;
      if (!cardId || !ownerWallet || !leagueId) return null;
      const rankRaw = e?.card?._rank;
      const rank = rankRaw != null && rankRaw !== "" ? Number(rankRaw) : null;
      return {
        cardId: String(cardId),
        ownerWallet: String(ownerWallet).toLowerCase(),
        level: String(e?.level ?? e?.card?._level ?? "Unknown"),
        leagueId: String(leagueId),
        leagueName: String(e?.card?._leagueDisplayName ?? leagueId),
        rank: rank != null && !Number.isNaN(rank) ? rank : null,
        weeklyScore: Number(e?.scoreWeek ?? e?.card?._weekScore ?? 0),
        seasonScore: Number(e?.scoreSeason ?? e?.card?._seasonScore ?? 0),
      };
    })
    .filter((r): r is SbsStandingsRow => r !== null);
}

export interface SbsUserProfile {
  displayName: string;
  imageUrl: string | null;
  equippedBadge: string | null;
  ripeness: {
    color: string;
    tier: number;
    range: string;
    label: string;
    count: number;
  };
}

// Same `rateLimited`-flagged-error convention as src/lib/opensea.ts, so
// callers (sync-standings.ts especially — it fires far more requests per
// run than anything else in this codebase, and hit real 429s from
// sbsfantasy.com during testing at concurrency 8) can retry with backoff
// instead of treating a rate limit as a hard failure.
function isRateLimitStatus(status: number) {
  return status === 429;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { accept: "application/json" },
    // Server-side fetch (this runs in the sync script / API routes, never in
    // the browser) so there's no CORS concern — that restriction only
    // applies to client-side fetches from a different origin.
    cache: "no-store",
  });
  if (isRateLimitStatus(res.status)) {
    throw Object.assign(new Error(`SBS API ${path} -> HTTP 429 (rate limited)`), { rateLimited: true });
  }
  if (!res.ok) {
    throw new Error(`SBS API ${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Current gameweek key, e.g. "2026REG-01". */
export async function getCurrentGameweek(): Promise<string> {
  const data = await getJson<{ gameweek: string }>("/api/standings?action=gameweek");
  return data.gameweek;
}

/**
 * Top-N leaderboard rows for a gameweek. `limit` is capped server-side at
 * 500 regardless of what you pass.
 */
export async function getLeaderboard(
  gameweek: string,
  orderBy: "SeasonScore" | "WeeklyScore" = "SeasonScore",
): Promise<SbsLeaderboardRow[]> {
  return getJson<SbsLeaderboardRow[]>(
    `/api/leaderboard?gameweek=${encodeURIComponent(gameweek)}&level=all&orderBy=${orderBy}&limit=500`,
  );
}

/** Resolve wallet addresses to display name / avatar / badge in one batch call. */
export async function getUserProfiles(
  wallets: string[],
): Promise<Record<string, SbsUserProfile>> {
  if (wallets.length === 0) return {};
  const res = await fetch(`${BASE_URL}/api/users/display-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ wallets }),
    cache: "no-store",
  });
  if (isRateLimitStatus(res.status)) {
    throw Object.assign(new Error("SBS API display-batch -> HTTP 429 (rate limited)"), { rateLimited: true });
  }
  if (!res.ok) throw new Error(`SBS API display-batch -> HTTP ${res.status}`);
  const data = (await res.json()) as { users: Record<string, SbsUserProfile> };
  return data.users;
}

/**
 * Which of these tokens are in a "Founder" draft. Founder drafts are the
 * streamed drafts SBS runs itself — normal 10-team pods where every team is
 * tagged as a founder team. SBS doesn't expose this as a level anywhere:
 * /api/standings, /api/leaderboard and the NFT's own LEVEL trait all say
 * "Pro" for these teams. The only place the tag lives is this endpoint,
 * which sbsfantasy.com's own Teams page calls to draw its founder badge.
 *
 * Confirmed live 2026-09-25: POSTing {tokens:[{tokenId, owner, leagueId}]}
 * returns {founderTokenIds: ["50", "152", ...]}. The whole pod is always
 * tagged (all 10 teams of 2026-fast-draft-8 "BBB #9" and 2026-fast-draft-51
 * "BBB #54" came back). Each token needs at least an owner or a leagueId —
 * a bare tokenId always comes back empty, so pass both.
 */
export async function getFounderTokenIds(
  tokens: { tokenId: string; owner: string | null; leagueId?: string }[],
): Promise<Set<string>> {
  if (tokens.length === 0) return new Set();
  const res = await fetch(`${BASE_URL}/api/founder-drafts/by-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tokens }),
    cache: "no-store",
  });
  if (isRateLimitStatus(res.status)) {
    throw Object.assign(new Error("SBS API founder-drafts/by-tokens -> HTTP 429 (rate limited)"), { rateLimited: true });
  }
  if (!res.ok) throw new Error(`SBS API founder-drafts/by-tokens -> HTTP ${res.status}`);
  const data = (await res.json()) as { founderTokenIds?: (string | number)[] };
  return new Set((data.founderTokenIds ?? []).map(String));
}

/**
 * SBS's own IN-APP marketplace (sbsfantasy.com's "Marketplace" tab) is a
 * completely separate venue from OpenSea — teams can be bought/sold there
 * directly, on-chain, WITHOUT ever appearing on OpenSea. Discovered this the
 * hard way: a user bought 3 teams through this marketplace and they never
 * showed up on /trades, even though sync-sales.ts (OpenSea) was working
 * perfectly and reported 0 skipped/unusable events on a real run. OpenSea's
 * public `event_type=sale` collection-events feed (opensea.ts) simply never
 * sees these trades at all — not a parsing bug, a genuine venue/scope gap.
 * See src/lib/jobs/syncSbsTrades.ts for the sync job built on this.
 *
 * Confirmed live (unauthenticated, plain fetch from sbsfantasy.com) on
 * 2026-09-14:
 *   - `/api/marketplace/collection` reports collection-wide stats, e.g.
 *     `{"floorPrice":15,"floorPriceSymbol":"USDC","totalSales":58,...}` —
 *     SBS's native marketplace has had only ~58 sales EVER, a small,
 *     tractable dataset (separate from OpenSea's own sale count).
 *   - There is NO collection-wide activity feed: `/api/marketplace/activity`
 *     with no query params 400s with `{"error":"wallet, tokenId, or
 *     tokenIds parameter required"}`. So the only way to enumerate sales is
 *     per-wallet (this project already has every known wallet in the
 *     `Owner` table) or per-tokenId (a much bigger space — the collection
 *     has ~14,000 tokens vs. a few thousand distinct owners — so wallet is
 *     the smaller search space and what getWalletMarketplaceActivity below
 *     uses).
 *   - `/api/marketplace/activity?wallet=<address>` returns that wallet's
 *     full activity history (`list` | `buy` | `sell` | `cancel`), newest
 *     first, 20 per page. Confirmed pagination: the response's `nextCursor`
 *     value is passed back as the REQUEST param `cursor` (NOT `nextCursor`
 *     or `after` — both of those were silently ignored and just re-returned
 *     page 1; only `cursor=` actually advanced the page, confirmed by
 *     checking for zero id-overlap between pages).
 *   - A single `type: "buy"` activity from the BUYER's own wallet is fully
 *     self-sufficient to reconstruct a complete sale (buyer=`walletAddress`,
 *     seller=`counterparty`, `price`, `tokenId`, `timestamp`,
 *     `orderHash`/`txHash`) — cross-checked by independently querying the
 *     seller's wallet and finding a matching `type: "sell"` entry with
 *     identical `orderHash`/`txHash`/`price`/`timestamp`. So the sync only
 *     needs `type === "buy"` entries, never `sell` (that would double-count
 *     the same trade from the other side).
 *   - `price` is already in DISPLAY units (e.g. `9` means $9.00, matching
 *     the in-app "Purchase Complete — $9.00" notification exactly) — unlike
 *     OpenSea's `payment.quantity`/`payment.decimals` pair, there's no
 *     decimals math to do here. Payment symbol isn't included per-activity;
 *     `/api/marketplace/collection`'s `floorPriceSymbol` says "USDC" for
 *     this app, so that's hard-coded as the payment symbol below.
 *   - `counterparty`, `orderHash`, and `txHash` are all `null` for `list`
 *     and `cancel` entries (no other party / no on-chain settlement yet).
 */
export interface SbsMarketplaceActivity {
  id: string;
  type: "list" | "buy" | "sell" | "cancel";
  walletAddress: string;
  tokenId: string;
  teamName?: string | null;
  price: number | null;
  counterparty: string | null;
  orderHash: string | null;
  txHash: string | null;
  timestamp: string; // ISO
}

export interface SbsMarketplaceActivityPage {
  activities: SbsMarketplaceActivity[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** One page of a single wallet's marketplace activity, newest first. Pass a
 * prior page's `nextCursor` back in as `cursor` to continue. */
export async function getWalletMarketplaceActivity(
  wallet: string,
  cursor?: string,
): Promise<SbsMarketplaceActivityPage> {
  const params = new URLSearchParams({ wallet });
  if (cursor) params.set("cursor", cursor);
  const data = await getJson<{
    activities?: any[];
    hasMore?: boolean;
    nextCursor?: string | null;
  }>(`/api/marketplace/activity?${params}`);
  const activities = (data?.activities ?? [])
    .map((a): SbsMarketplaceActivity | null => {
      if (!a?.id || !a?.type || !a?.walletAddress || !a?.tokenId || !a?.timestamp) return null;
      return {
        id: String(a.id),
        type: a.type,
        walletAddress: String(a.walletAddress).toLowerCase(),
        tokenId: String(a.tokenId),
        teamName: a.teamName ?? null,
        price: a.price != null ? Number(a.price) : null,
        counterparty: a.counterparty ? String(a.counterparty).toLowerCase() : null,
        orderHash: a.orderHash ?? null,
        txHash: a.txHash ?? null,
        timestamp: String(a.timestamp),
      };
    })
    .filter((a): a is SbsMarketplaceActivity => a !== null);
  return {
    activities,
    hasMore: Boolean(data?.hasMore),
    nextCursor: data?.nextCursor ?? null,
  };
}

/** Parses "BBB #687 · #7304" into { leaguePrefix: "BBB #687", cardId: "7304" }. */
export function parseTeamName(teamName: string): { leaguePrefix: string; cardId: string | null } {
  const match = teamName.match(/^(.*?)(?:\s*·\s*#(\d+))?$/);
  return {
    leaguePrefix: match?.[1]?.trim() ?? teamName,
    cardId: match?.[2] ?? null,
  };
}

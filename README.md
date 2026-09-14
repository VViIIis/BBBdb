# BBBdb

An unofficial, free public leaderboard and team-owner dashboard for **SBS
Banana Best Ball** (Spoiled Banana Society) — the name's a play on
[bbmdb.com](https://bbmdb.com), the equivalent tracker for Underdog Best
Ball Mania, which this project is inspired by.

This repo started as a **working starter**, not a finished polished
product, and has grown from there: the architecture, data pipeline, and
core pages (Leaderboard, Owner Portfolio, Team/Roster cards, Pod standings,
Most-Teams-Drafted) are all real and functional — see "What's not built
yet" below for what's still missing.

## What SBS actually is (read this before touching the data model)

SBS Banana Best Ball is a best-ball fantasy football format where teams are
tradeable NFTs (ERC-721, on Base, collection:
[Banana Best Ball 4](https://opensea.io/collection/banana-best-ball-4),
14,040 minted). A few things make it different from a normal best-ball site
like bbmdb, which matter for anyone extending this:

- **You draft "Team Positions," not players.** Instead of drafting Patrick
  Mahomes, you draft e.g. "KC QB" or "DAL WR1," and each week you
  automatically score whichever real player was the top performer at that
  slot for that team (WR2/RB2 = that team's *second*-highest scorer that
  week). Full PPR scoring — see the FAQ's "Scoring" section for the exact
  point values.
- **Tournament structure is pod-based, like Best Ball Mania.** Weeks 1–14:
  cumulative scoring in a 10-team pod, top 2 advance. Week 15: fresh pod of
  10, top 2 advance. Week 16: another fresh pod, top 2 advance. Week 17:
  finals pod for the grand prize. Hall of Fame leagues run their own
  parallel 15–17 track. Jackpot winners skip straight to the finals.
- **There are multiple tiers/pass types**: Pro (labeled "BBB" in team
  names), Hall of Fame ("HOF"), Jackpot, JackHOF, and Founder — each its own
  entry type/prize track.
- **Teams are tradeable** both on SBS's own in-app marketplace and on
  OpenSea, so "who owns this team" can change mid-season.

## Multi-season support

BBBdb tracks more than one season side by side. A `Season` table (see
`prisma/schema.prisma`) records each season's slug, display name, and which
chain/contract its NFTs live on — this matters because **different SBS
seasons are entirely different NFT collections, sometimes on different
chains**: BBB IV (the current, live season) is on Base at
`0xadf5b9b46616de6d073f226e7b7c532ae2cffb80`; BBB III (concluded, imported as
history) is on **Ethereum mainnet** at
`0x2bff6f4284774836d867ced2e9b96c27aaee55b7`. Every `Team` row belongs to a
season (`seasonSlug`, part of its primary key alongside `cardId`, since card
ids reset per collection), and every page/route that shows teams takes a
`season` route param and offers a season switcher (`SeasonTabs`) when more
than one season exists.

Live seasons (`Season.isActive = true`) get kept current by the regular
`sync:leaderboard` / `sync:collection` scripts. Concluded seasons are
imported **once**, as a final snapshot only — there's no live SBS API for a
season that's over, so `scripts/import-season.ts` pulls whatever OpenSea's
NFT metadata still shows frozen in the `RANK` / `WEEK-SCORE` / `SEASON-SC0RE`
traits (SBS appears to leave these in place after a season ends rather than
clear them) and writes one `ScoreSnapshot` per team, dated `<slug>-final`
(e.g. `bbb3-final`) instead of a real gameweek number. No week-by-week
history is available or attempted for imported seasons — just final
standings.

**Import a past season** (defaults to BBB III):

```bash
npm run import:season
# or, for a different past season later:
SEASON_SLUG=bbb2 SEASON_NAME="Banana Best Ball II" \
SEASON_CHAIN=ethereum SEASON_CONTRACT=0x... SEASON_MAX_TOKEN_ID=... \
npm run import:season
```

One caveat noted in `scripts/import-season.ts`'s own comments: BBB IV's
OpenSea trait names were confirmed against a real live response while
building this app (see `src/lib/opensea.ts`), but **BBB III's trait names
have not been live-verified the same way** — the importer assumes the same
`trait_type` strings carry over. If BBB III's scores/ranks come out empty or
wrong after running the import, `console.log` one real `nft` response for
that contract and compare its trait names to what `upsertToken()` in
`import-season.ts` expects.

## Data sources (and their real limitations)

Two sources feed this app, and each covers a gap the other has:

| Source | What it gives you | Limitation |
|---|---|---|
| `sbsfantasy.com`'s `/api/leaderboard` (undocumented, no auth) | Live rank, weekly/season score, username, wallet, level, and pod (`leagueId`) for every scoring team | **Caps at 500 results per call and ignores offset/page/cursor** (confirmed by testing) — only gives you the top ~500 teams per ordering, not all 14,040 |
| `sbsfantasy.com`'s `/api/standings?draftId=...` (undocumented, no auth) | Complete standings (all ~10 teams, regardless of global rank) for ONE pod at a time | No cap, but there's no "list all pods" endpoint — you have to walk pod ids yourself (see below) |
| OpenSea API v2 (official, needs a free API key) | Every minted token, its current owner wallet, roster traits, and marketplace listings/sales | No live game scores — this is the census/ownership/roster source, not the scoring source |

`scripts/sync-leaderboard.ts` pulls from `/api/leaderboard` (fast, a handful
of calls, run often — every 15–60 min) — good for "what's #1 right now" but,
by itself, leaves most teams with **no score at all**, since most teams
never crack a global top-500 pull. `scripts/sync-standings.ts` fixes that:
it walks every pod id (`draftId`, e.g. `2026-fast-draft-606`) and pulls that
pod's full standings via `/api/standings`, so every drafted team gets a real
score regardless of rank — see `src/lib/sbsApi.ts`'s docblock for exactly
how the valid `draftId` ranges were found (live-probed against the site,
since there's no documentation or "list pods" endpoint). It's a much
heavier pull (~1,500 HTTP calls, one per candidate pod, most of which miss
and are cheaply skipped — same tolerant-walk shape as `sync-collection.ts`'s
token walk), so it runs less often (every 2 hours by default). Run it once
manually (`npm run sync:standings`) any time an owner's page looks like it's
"only showing top scores." `scripts/sync-collection.ts` pulls from OpenSea
(heavier still, run daily) to fill in every team that exists at all — even
ones that have never scored a point — and to track ownership changes from
trading. All three write into the same `Team` / `Owner` / `ScoreSnapshot`
tables, so pages don't need to know which source a row came from.

**The SBS client (`src/lib/sbsApi.ts`) was verified end-to-end against the
live site** — every function in it (`getCurrentGameweek`, `getLeaderboard`,
`getFullStandings`, `getUserProfiles`, `parseTeamName`) was test-called
against real sbsfantasy.com responses while building this, including
confirming the `/api/leaderboard` 500-row cap, the exact `/api/standings`
per-pod response shape, and the exact request body shape `display-batch`
expects. The OpenSea client (`src/lib/opensea.ts`) is
written from OpenSea's documented v2 shape and what's visible in their UI (I
inspected a real token's Traits panel — 23 traits, including per-slot
values like `PHI-QB` plus `League #`, `Level`, `Rank`, `Status`,
`Week-Score`, `Season-Score`) but was **not** test-called, since that needs
an API key I don't have. `console.log` the first page of a real pull and
adjust the `traitValue()` calls in `scripts/sync-collection.ts` if the exact
`trait_type` strings differ from what's guessed here.

A note on using SBS's own API: it's undocumented (not a published,
versioned API SBS committed to), so it can change or get rate-limited
without notice. The sync script only reads data the site already shows to
any anonymous visitor, and is designed to run on a schedule rather than
hammering it — keep it that way, and expect to revisit `sbsApi.ts` if SBS
changes their frontend.

## Data model

See `prisma/schema.prisma` for the full schema with inline comments.
Short version: `Season` (one row per SBS season — slug, chain, contract) →
has many `Team` (by NFT card id, keyed `(seasonSlug, cardId)` since card ids
reset per collection) → has many `ScoreSnapshot` (one row per team per
gameweek, so score history is preserved instead of overwritten). `Owner` (by
wallet) is global, not season-scoped — the same wallet's teams across every
season all point back to one `Owner` row, which is what makes the all-time
owner portfolio page possible. A `SyncLog` table gives you a simple "data
last updated at ___" without needing an external monitoring tool.

## What's built

- **Leaderboard** (`/`, `/?season=<slug>`) — top teams by season score,
  filterable by level (Pro / HOF / Jackpot / JackHOF / Founder), reading
  from your database (not a live call on every page load). A season switcher
  appears once more than one season exists.
- **Full score coverage, not just the top 500** — `scripts/sync-standings.ts`
  walks every pod on the site (not just the global top scorers) so an
  owner's page, team page, or pod page shows a real score for every team
  they hold, not just whichever one happens to rank well globally. See the
  "Data sources" section above for how this works and why it's a separate
  script from `sync-leaderboard.ts`.
- **Owner portfolio** (`/owner/[wallet]`) — every known team for one wallet,
  scoped to one season at a time (defaults to the currently-active season;
  a season switcher lets you pick BBB III vs BBB IV, plus an "All-time" tab
  for the wallet's whole combined BBBdb history), with highest-scoring team
  and average season points for whatever's selected. Click any owner name
  on the leaderboard to get here.
- **Team/roster card** (`/team/[season]/[cardId]`) — one team's owner,
  level/status, full DB score history across every synced gameweek, and a
  best-effort live pull of its drafted roster slots + card image from
  OpenSea (roster data isn't stored in the DB — see the note in
  `src/lib/opensea.ts` — so this page fetches it live and falls back
  gracefully if OpenSea is unreachable). The OpenSea chain/contract used
  comes from the team's own `Season` row, since seasons can live on
  different chains (BBB III is Ethereum, BBB IV is Base). Click any team
  name anywhere on the site to get here.
- **Pod standings** (`/pod/[season]/[level]/[leagueName]`) — the up-to-10
  teams sharing a pod, ranked by season score, with the top 2 flagged as
  "advancing" per SBS's weeks 1–14 rule. Click "(pod)" next to any team.
  **Important data-model note**: pods are grouped by `(season, level,
  leagueName)`, *not* the `Team.leagueId` column. The two sync scripts
  disagree on what goes in `leagueId` — `sync-leaderboard.ts` (SBS's API)
  writes SBS's real internal slug (e.g. `2026-fast-draft-606`), while
  `sync-collection.ts` (OpenSea) writes a synthetic id derived from the
  "League #" trait (e.g. `sbs-league-687`) — so whichever sync touched a row
  last silently determines its `leagueId` format, and grouping by it would
  fracture real pods. `leagueName` (e.g. `BBB #687`) is written identically
  by both sources, so it's the reliable key — just remember pod numbering
  resets per level (`Hall of Fame` and `JackHOF` both have their own "BBB
  #99") and per season (BBB III and BBB IV both have a "BBB #1"), so both
  have to be part of the key too. If you want to fix `leagueId` properly
  later, that's a real (if minor) inconsistency worth cleaning up.
- **Most teams drafted** (`/owners`) — owners ranked by number of drafted
  teams in the active season (separate from undrafted Draft Passes they're
  just holding). SBS has no per-wallet draft cap (unlike Underdog's
  150-entry limit), so this is a real leaderboard, not trivia — top 100
  shown.
- **Exposure** (`/exposure`) — three independent lookups, all sortable by
  clicking a column header (Team Position/Owner, Teams, Exposure %):
  - Look up an **owner** (username or wallet) to see which Team Positions
    (e.g. `CHI QB`, `DAL WR1`) they're most exposed to across their drafted
    teams for one season, with a position filter (QB / RB / WR / TE / DST).
  - Look up a single **Team Position** (e.g. `MIN WR1`) to see the reverse —
    every owner who's drafted it, ranked by team count or by % of their
    portfolio (those two rankings differ once owners hold different numbers
    of teams).
  - Look up a **stack** — two Team Positions (e.g. `NE QB` + `NE WR1`) — to
    see which owners have drafted BOTH on the same team, same ranking
    options as the single-position lookup. All three lookups support a
    partial/contains search with a disambiguation picker when more than one
    Team Position matches.

  SBS teams draft team-positions, not individual real players (see "What
  SBS actually is" above), so a Team Position is the actual unit of
  exposure risk here — this is the closest equivalent to bbmdb's
  per-player exposure tool, adapted to how SBS's draft board works.
  Backed by a new `RosterSlot` table (one row per drafted slot per team) —
  populated by `sync-collection.ts` and `import-season.ts`, both of which
  now capture roster slots alongside everything else they were already
  pulling from OpenSea per token. If exposure looks empty for a season, that
  season's collection/import script hasn't been (re-)run since roster
  capture was added — re-running either is safe (insert-only, skips rows
  that already exist).
- **Trades** (`/trades`) — marketplace sale activity: which Team Positions
  change hands most (same unit as `/exposure`, measured by trade count
  instead of holdings), a top-traders leaderboard (bought/sold counts +
  volume in whatever currency the collection actually trades in, ranked by
  total transactions), and a recent-sales feed. Prices are labeled from each
  sale's real `paymentSymbol` (BBB IV trades in USDC, not ETH, despite the
  `Sale.priceEth` column name — that name's a holdover from writing this
  before a real sale was ever seen; the column just holds whatever unit
  `paymentSymbol` names). Backed by a new `Sale` table, populated by
  `scripts/sync-sales.ts` from OpenSea's collection-wide `/events` endpoint
  (`event_type=sale` only — plain transfers/mints/gifts are excluded on
  purpose). Only works for a season
  that has `Season.collectionSlug` set (e.g. `banana-best-ball-4`, from that
  collection's `opensea.io/collection/<slug>` URL) — a season without one
  shows a plain "not set up" message instead of erroring. **v1 scope**:
  BBB IV only; BBB III (concluded) was deliberately left without a
  `collectionSlug` since there's no new trading left to track there.
  **Caveat worth knowing**: the exact OpenSea events field names
  (`sync-sales.ts`/`src/lib/opensea.ts`) were written from OpenSea's
  documented v2 shape, not verified against a live response — the first
  real sync logs one full raw event so a naming mismatch is obvious
  immediately instead of silently producing empty/wrong rows; check that log
  line after the first real run and adjust `eventOccurredAtSeconds()` /
  `eventKeyFor()` in `src/lib/jobs/syncSales.ts` if needed.
- `/api/leaderboard`, `/api/owner/[wallet]`, `/api/team/[season]/[cardId]`,
  `/api/pod/[season]/[level]/[leagueName]`, `/api/owners`, `/api/exposure/[wallet]`,
  and `/api/trades` — the same data as JSON, if you want to build a
  mobile app or another frontend against it later.
- `/api/sync` — a secret-protected endpoint for triggering a leaderboard
  sync via Vercel Cron.

## What's not built yet

Full bbmdb-style parity is now in place (Exposure and Trades were the last
two pieces). Nothing major is currently planned — future ideas would be
things like week-over-week score charts or price-history charts per Team
Position, not new top-level features.

## Getting it running locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum
npx prisma migrate dev --name init
npm run sync:leaderboard   # pulls real data right away (top scorers only)
npm run sync:standings     # fills in every OTHER team's score too (slower)
npm run dev                # http://localhost:3000
```

## Deploying for free

This stack (Next.js + Postgres) fits comfortably in free tiers:

1. **Database**: [Supabase](https://supabase.com) or
   [Neon](https://neon.tech) free tier Postgres. Copy the connection string
   into `DATABASE_URL`.
2. **Hosting**: [Vercel](https://vercel.com) free (Hobby) tier — connect
   this repo, set the `DATABASE_URL`, `SYNC_SECRET`, and (if using OpenSea
   features) `OPENSEA_API_KEY` environment variables in the Vercel project
   settings, deploy. A season's OpenSea collection slug (for `/trades`)
   lives in the database as `Season.collectionSlug`, not an env var — see
   "Trades" above.
3. **Domain**: optional — Vercel gives you a free `*.vercel.app` subdomain
   out of the box; buy a real domain later if you want (any registrar,
   point it at Vercel).
4. **Run migrations against your production DB** once, from your machine or
   CI: `DATABASE_URL=<prod-url> npx prisma migrate deploy`.
5. **Keeping data fresh** — two free options, can use either or both:
   - *Vercel Cron* (`vercel.json`, already wired to `/api/sync`) — simplest,
     but Vercel's free Hobby tier currently limits cron jobs to **once a
     day**. Fine for a low-key site, not for "updates during the game."
   - *GitHub Actions* (`.github/workflows/sync.yml`) — free CI minutes, runs
     on whatever schedule you want (wired to every 15 minutes by default).
     Add `DATABASE_URL` as a repo secret. This is the better default if you
     want scores to feel live on Sundays.
   - For full score coverage (`sync:standings`, every team — not just top
     scorers), a GitHub Actions workflow
     (`.github/workflows/sync-standings.yml`) is wired up on a 2-hour
     schedule by default — needs only the same `DATABASE_URL` secret. It's
     a much heavier pull than `sync:leaderboard` (walks ~1,500 pod ids), so
     it shouldn't run as often.
   - For the full NFT census (`sync:collection`), run it manually or on a
     much slower GitHub Actions schedule (e.g. daily) — it's a much heavier
     pull than the leaderboard sync.
   - For marketplace sales (`sync:sales`, powers `/trades`), a GitHub Actions
     workflow (`.github/workflows/sync-sales.yml`) is wired up on a 30-minute
     schedule by default — needs both `DATABASE_URL` and `OPENSEA_API_KEY`
     as repo secrets.

## Tech stack

Next.js 14 (App Router) + TypeScript + Tailwind CSS + Prisma + Postgres.
Chosen because it's the same stack SBS's own site runs on (so patterns
transfer), and because every piece has a real free tier.

## Legal / good-neighbor notes

This is a fan project, not affiliated with SBS/Spoiled Banana Society or
OpenSea. It's read-only (no wallet connect, no trading, no write access to
anyone's account) and only surfaces data both sites already show publicly.
Keep the footer disclaimer in `src/app/layout.tsx` intact, and keep sync
frequency reasonable — the goal is a useful community tool, not a burden on
SBS's infrastructure.

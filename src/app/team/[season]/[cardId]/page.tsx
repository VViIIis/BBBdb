import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getNftByTokenId, getRosterSlots, traitValue } from "@/lib/opensea";

// Roster slots and the card image essentially never change once drafted, and
// pulling them from OpenSea on every request would burn through the API key's
// rate limit fast on a page anyone can link to. Revalidate every 5 minutes
// instead of on every hit — score history still comes straight from our DB.
export const revalidate = 300;

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function TeamPage({
  params,
}: {
  params: { season: string; cardId: string };
}) {
  const cardId = params.cardId;

  const team = await prisma.team.findUnique({
    where: { seasonSlug_cardId: { seasonSlug: params.season, cardId } },
    include: {
      owner: true,
      season: true,
      scores: { orderBy: { gameweek: "asc" } },
    },
  });

  if (!team) notFound();

  const isDraftPass = team.status === "draft_pass";

  // Best-effort live pull for roster traits + card image — not stored in our
  // DB (see src/lib/opensea.ts). Contract/chain come from the team's own
  // Season row, since different seasons live on different chains/contracts
  // (BBB III is Ethereum, BBB IV is Base). If OpenSea is unreachable or
  // rate-limited, fall back to showing whatever we already have from the
  // database rather than failing the whole page.
  let roster: { slot: string; value: string }[] = [];
  let imageUrl: string | null = null;
  let openseaUrl: string | null = null;
  let rank: string | number | undefined;
  let liveFetchFailed = false;
  try {
    const nft = await getNftByTokenId(team.season.contract, cardId, team.season.chain);
    if (nft) {
      roster = getRosterSlots(nft);
      imageUrl = nft.image_url ?? null;
      openseaUrl = nft.opensea_url ?? null;
      rank = traitValue(nft, "RANK");
    }
  } catch (err) {
    // Logged server-side (visible in Vercel's Logs tab) so a real cause
    // (missing/invalid API key, rate limit, network error) is diagnosable —
    // the user-facing message below stays generic on purpose.
    console.error("[team page] OpenSea live roster fetch failed:", err);
    liveFetchFailed = true;
  }

  const latest = team.scores[team.scores.length - 1] ?? null;
  const podHref = !isDraftPass
    ? `/pod/${team.seasonSlug}/${encodeURIComponent(team.level)}/${encodeURIComponent(team.leagueName)}`
    : null;

  return (
    <main>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start">
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            className="h-40 w-40 shrink-0 rounded-lg border border-ink-600 object-cover"
          />
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">
            {team.leagueName} · #{team.cardId}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {team.season.name} · Owned by{" "}
            <Link href={`/owner/${team.ownerWallet}`} className="hover:text-banana-400">
              {team.owner.displayName ?? shortWallet(team.ownerWallet)}
            </Link>
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <Badge>{isDraftPass ? "Draft Pass" : team.level}</Badge>
            {podHref && (
              <Link
                href={podHref}
                className="rounded-full bg-ink-800 px-3 py-1 text-zinc-300 hover:bg-ink-700 hover:text-banana-400"
              >
                View pod →
              </Link>
            )}
            {openseaUrl && (
              <a
                href={openseaUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-ink-800 px-3 py-1 text-zinc-300 hover:bg-ink-700 hover:text-banana-400"
              >
                View on OpenSea ↗
              </a>
            )}
          </div>
        </div>
      </div>

      {isDraftPass ? (
        <p className="rounded-lg border border-ink-600 bg-ink-800 px-4 py-6 text-center text-zinc-400">
          This is an undrafted Draft Pass — it will reveal into a full team once its owner drafts.
        </p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rank" value={rank ?? "—"} />
            <Stat label="Weekly pts" value={latest ? latest.weeklyScore.toFixed(2) : "—"} />
            <Stat label="Season pts" value={latest ? latest.seasonScore.toFixed(2) : "—"} />
            <Stat label="Gameweeks tracked" value={team.scores.length} />
          </div>

          <section className="mb-6">
            <h2 className="mb-2 text-lg font-semibold">Roster</h2>
            {roster.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {roster.map((r) => (
                  <div
                    key={r.slot}
                    className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2"
                  >
                    <div className="text-xs text-zinc-500">{r.slot}</div>
                    <div className="font-mono text-sm">{r.value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                {liveFetchFailed
                  ? "Live roster is temporarily unavailable (OpenSea didn't respond) — try refreshing in a bit."
                  : "No roster data available."}
              </p>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold">Score history</h2>
            <div className="overflow-x-auto rounded-lg border border-ink-600">
              <table className="w-full sm:min-w-[420px] text-left text-sm">
                <thead className="bg-ink-800 text-zinc-400">
                  <tr>
                    <th className="px-2 py-2 sm:px-3">Gameweek</th>
                    <th className="px-2 py-2 sm:px-3">Rank</th>
                    <th className="px-2 py-2 sm:px-3 text-right">Weekly</th>
                    <th className="px-2 py-2 sm:px-3 text-right">Season</th>
                  </tr>
                </thead>
                <tbody>
                  {[...team.scores].reverse().map((s) => (
                    <tr key={s.gameweek} className="border-t border-ink-600">
                      <td className="px-2 py-2 sm:px-3">{s.gameweek}</td>
                      <td className="px-2 py-2 sm:px-3 text-zinc-400">{s.rank ?? "—"}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono">{s.weeklyScore.toFixed(2)}</td>
                      <td className="px-2 py-2 sm:px-3 text-right font-mono font-semibold">
                        {s.seasonScore.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {team.scores.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-zinc-500">
                        No score snapshots yet — this team hasn't appeared in the SBS leaderboard
                        sync (it's outside the top 500 scorers for every tracked gameweek so far).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-ink-800 px-3 py-1 text-zinc-300">{children}</span>;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

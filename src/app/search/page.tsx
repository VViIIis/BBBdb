import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = (searchParams.q ?? "").trim();

  const [owners, teams] = q
    ? await Promise.all([
        prisma.owner.findMany({
          where: {
            OR: [
              { displayName: { contains: q, mode: "insensitive" } },
              { wallet: { contains: q.toLowerCase() } },
            ],
          },
          include: { _count: { select: { teams: true } } },
          orderBy: { displayName: "asc" },
          take: 50,
        }),
        // Card/token-id search — e.g. Jack sees a team on SBS's own
        // marketplace at sbsfantasy.com/marketplace/11788, where "11788" is
        // that same NFT token id this app already stores as Team.cardId
        // (see schema.prisma's comment on Team), and wants to paste that
        // number here and land on its BBBdb page. `contains` (not exact)
        // so a partial number still narrows things down, same looseness
        // the wallet search above already has.
        prisma.team.findMany({
          where: { cardId: { contains: q } },
          include: { owner: true, season: true },
          orderBy: [{ seasonSlug: "desc" }, { cardId: "asc" }],
          take: 50,
        }),
      ])
    : [[], []];

  // Paste a pure card number and land straight on the team page instead of
  // picking it out of a one-row list — that's the whole point of this
  // feature. Gated on the query being ALL digits (not on owners also being
  // empty): a numeric string can coincidentally substring-match inside some
  // wallet address purely by chance, and that shouldn't block the one
  // obviously-intended result from just taking you there.
  const isNumericQuery = q.length > 0 && /^\d+$/.test(q);
  if (isNumericQuery && teams.length === 1) {
    redirect(`/team/${teams[0].seasonSlug}/${teams[0].cardId}`);
  }

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Search</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Find an owner by username or wallet, or a team by its card # (the number in a team&rsquo;s
        sbsfantasy.com marketplace link).
      </p>

      <form action="/search" method="GET" className="mb-6 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Username, wallet, or card #..."
          autoFocus
          className="w-full max-w-sm rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-banana-400"
        />
        <button
          type="submit"
          className="rounded-lg bg-banana-400 px-4 py-2 text-sm font-semibold text-ink-900"
        >
          Search
        </button>
      </form>

      {q && teams.length > 0 && (
        <div className="mb-6 overflow-x-auto rounded-lg border border-ink-600">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-ink-800 text-zinc-400">
              <tr>
                <th className="px-3 py-2">Card</th>
                <th className="px-3 py-2">Season</th>
                <th className="px-3 py-2">Level</th>
                <th className="px-3 py-2">Owner</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={`${t.seasonSlug}-${t.cardId}`} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-3 py-2">
                    <Link href={`/team/${t.seasonSlug}/${t.cardId}`} className="hover:text-banana-400">
                      {t.leagueName} &middot; #{t.cardId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{t.season.name}</td>
                  <td className="px-3 py-2 text-zinc-400">{t.level}</td>
                  <td className="px-3 py-2">
                    <Link href={`/owner/${t.ownerWallet}`} className="hover:text-banana-400">
                      {t.owner.displayName ?? shortWallet(t.ownerWallet)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {q && owners.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-ink-600">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead className="bg-ink-800 text-zinc-400">
              <tr>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2 text-right">Teams</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => (
                <tr key={o.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                  <td className="px-3 py-2">
                    <Link href={`/owner/${o.wallet}`} className="hover:text-banana-400">
                      {o.displayName ?? shortWallet(o.wallet)}
                    </Link>
                    {o.displayName && (
                      <span className="ml-2 font-mono text-xs text-zinc-500">
                        {shortWallet(o.wallet)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{o._count.teams}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {q && teams.length === 0 && owners.length === 0 && (
        <p className="px-1 py-8 text-center text-sm text-zinc-500">
          No owners or teams found matching &ldquo;{q}&rdquo;.
        </p>
      )}
    </main>
  );
}

import Link from "next/link";
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

  const owners = q
    ? await prisma.owner.findMany({
        where: {
          OR: [
            { displayName: { contains: q, mode: "insensitive" } },
            { wallet: { contains: q.toLowerCase() } },
          ],
        },
        include: { _count: { select: { teams: true } } },
        orderBy: { displayName: "asc" },
        take: 50,
      })
    : [];

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Search</h1>
      <p className="mb-4 text-sm text-zinc-400">Find an owner by username or wallet address.</p>

      <form action="/search" method="GET" className="mb-6 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Username or wallet..."
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

      {q && (
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
              {owners.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-3 py-8 text-center text-zinc-500">
                    No owners found matching &ldquo;{q}&rdquo;.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

import Link from "@/components/Link";
import OwnerAvatar from "@/components/OwnerAvatar";
import { prisma } from "@/lib/db";
import { resolveSeason } from "@/lib/seasons";
import { getWinnings, LAST_PRIZE_WEEK, WEEKLY_PRIZES } from "@/lib/winnings";

export const dynamic = "force-dynamic";

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function money(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function placeLabel(place: number, tiedWith: number) {
  const medal = ["🥇", "🥈", "🥉"][place - 1] ?? `${place}th`;
  return tiedWith > 1 ? `T-${place}` : medal;
}

export default async function WinningsPage() {
  // Weekly cash prizes are this season's payout table, so this page always
  // shows the live season.
  const season = await resolveSeason();
  const { weeks, earners, totalPaid, finalWeeks } = await getWinnings(season.slug);

  const wallets = new Set<string>(earners.map((e) => e.wallet));
  for (const w of weeks) for (const win of w.winners) wallets.add(win.ownerWallet);
  const owners = await prisma.owner.findMany({
    where: { wallet: { in: [...wallets], mode: "insensitive" } },
    select: { wallet: true, displayName: true, imageUrl: true },
  });
  const ownerByWallet = new Map(owners.map((o) => [o.wallet.toLowerCase(), o]));

  function OwnerCell({ wallet }: { wallet: string }) {
    const owner = ownerByWallet.get(wallet);
    return (
      <Link href={`/owner/${wallet}`} className="flex min-w-0 items-center gap-2 hover:text-banana-400">
        <OwnerAvatar imageUrl={owner?.imageUrl} />
        <span className="truncate">{owner?.displayName ?? shortWallet(wallet)}</span>
      </Link>
    );
  }

  return (
    <main>
      <h1 className="mb-1 text-2xl font-bold">Weekly winnings</h1>
      <p className="mb-4 text-sm text-zinc-400">
        {season.name} · each week&rsquo;s top 5 Weekly scores win {WEEKLY_PRIZES.map(money).join(" / ")}{" "}
        (weeks 1–{LAST_PRIZE_WEEK}). {money(totalPaid)} won across {finalWeeks}{" "}
        {finalWeeks === 1 ? "week" : "weeks"} so far.
      </p>

      <h2 className="mb-2 text-lg font-semibold">Most won</h2>
      <div className="mb-8 overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full text-left text-sm sm:min-w-[640px]">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-2 py-2 sm:px-3">#</th>
              <th className="px-2 py-2 sm:px-3">Owner</th>
              <th className="px-2 py-2 text-right sm:px-3">Won</th>
              <th className="px-2 py-2 text-right sm:px-3">Cashes</th>
              <th className="hidden px-2 py-2 text-right sm:table-cell sm:px-3">1st</th>
              <th className="hidden px-2 py-2 sm:table-cell sm:px-3">Weeks</th>
            </tr>
          </thead>
          <tbody>
            {earners.map((e, i) => (
              <tr key={e.wallet} className="border-t border-ink-600 hover:bg-ink-800/60">
                <td className="px-2 py-2 text-zinc-400 sm:px-3">{i + 1}</td>
                <td className="max-w-[10rem] px-2 py-2 sm:max-w-none sm:px-3">
                  <OwnerCell wallet={e.wallet} />
                </td>
                <td className="px-2 py-2 text-right font-mono font-semibold text-banana-400 sm:px-3">
                  {money(e.total)}
                </td>
                <td className="px-2 py-2 text-right font-mono text-zinc-400 sm:px-3">{e.cashes}</td>
                <td className="hidden px-2 py-2 text-right font-mono text-zinc-400 sm:table-cell sm:px-3">
                  {e.firsts || "—"}
                </td>
                <td className="hidden px-2 py-2 text-xs text-zinc-500 sm:table-cell sm:px-3">
                  {e.weeks.map((w) => `W${w.week} ${money(w.prize)}`).join(" · ")}
                </td>
              </tr>
            ))}
            {earners.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-zinc-500">
                  No weeks finished yet for {season.name}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2 text-lg font-semibold">Week by week</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {weeks.map((w) => (
          <section key={w.gameweek} className="rounded-lg border border-ink-600">
            <div className="flex items-center justify-between bg-ink-800 px-3 py-2 text-sm">
              <Link href={`/?week=${w.gameweek}&sort=weekly`} className="font-semibold hover:text-banana-400">
                Week {w.week}
              </Link>
              {!w.final && <span className="text-xs text-banana-400">in progress · not final</span>}
            </div>
            <table className="w-full text-sm">
              <tbody>
                {w.winners.map((win) => (
                  <tr key={win.teamCardId} className="border-t border-ink-600">
                    <td className="w-10 px-2 py-1.5 text-center text-zinc-400 sm:px-3">
                      {placeLabel(win.place, win.tiedWith)}
                    </td>
                    <td className="max-w-[9rem] px-2 py-1.5 sm:px-3">
                      <OwnerCell wallet={win.ownerWallet} />
                      <Link
                        href={`/team/${season.slug}/${win.teamCardId}`}
                        className="block truncate text-xs text-zinc-500 hover:text-banana-400"
                      >
                        {win.leagueName} · #{win.teamCardId} · {win.level}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono sm:px-3">{win.weeklyScore.toFixed(2)}</td>
                    <td
                      className={`px-2 py-1.5 text-right font-mono sm:px-3 ${w.final ? "text-banana-400" : "text-zinc-500"}`}
                    >
                      {money(win.prize)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>

      <p className="mt-6 text-xs text-zinc-500">
        Prizes are credited to whoever held the team when that week&rsquo;s games ended. Tied teams split
        the prizes for the places they cover. Unofficial: SBS&rsquo;s own payouts are the final word.
      </p>
    </main>
  );
}

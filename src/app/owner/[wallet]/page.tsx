import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function OwnerPage({ params }: { params: { wallet: string } }) {
  const wallet = params.wallet.toLowerCase();

  // Owner is global across seasons on purpose — this page is a wallet's
  // all-time portfolio, spanning every season it's held a team in.
  const owner = await prisma.owner.findUnique({
    where: { wallet },
    include: {
      teams: {
        include: { season: true, scores: { orderBy: { capturedAt: "desc" }, take: 1 } },
      },
    },
  });

  if (!owner) notFound();

  const teams = owner.teams
    .map((t) => ({ ...t, latest: t.scores[0] ?? null }))
    .sort((a, b) => (b.latest?.seasonScore ?? 0) - (a.latest?.seasonScore ?? 0));

  const scored = teams.filter((t) => t.latest);
  // `teams` is already sorted by season score desc (unscored teams sort to
  // the bottom), so the first scored team is the best one.
  const bestTeam = scored[0] ?? null;
  const totalSeasonScore = scored.reduce((sum, t) => sum + (t.latest?.seasonScore ?? 0), 0);

  return (
    <main>
      <div className="mb-6 flex items-center gap-3">
        {owner.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={owner.imageUrl} alt="" className="h-14 w-14 rounded-full border border-ink-600" />
        )}
        <div>
          <h1 className="text-2xl font-bold">{owner.displayName ?? shortWallet(owner.wallet)}</h1>
          <p className="font-mono text-xs text-zinc-500">{owner.wallet}</p>
          <Link
            href={`/exposure?q=${owner.wallet}`}
            className="mt-1 inline-block text-xs text-zinc-500 hover:text-banana-400"
          >
            View exposure →
          </Link>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Teams" value={teams.length} />
        <Stat label="Scored teams" value={scored.length} />
        <div className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2">
          <div className="text-xs text-zinc-500">Highest scoring team</div>
          {bestTeam ? (
            <div className="text-lg font-semibold">
              {bestTeam.latest!.seasonScore.toFixed(2)}{" "}
              <Link
                href={`/team/${bestTeam.seasonSlug}/${bestTeam.cardId}`}
                className="text-sm font-normal text-zinc-400 hover:text-banana-400"
              >
                #{bestTeam.cardId}
              </Link>
            </div>
          ) : (
            <div className="text-lg font-semibold">—</div>
          )}
        </div>
        <Stat
          label="Avg season pts"
          value={scored.length ? (totalSeasonScore / scored.length).toFixed(2) : "—"}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-600">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-ink-800 text-zinc-400">
            <tr>
              <th className="px-3 py-2">Season</th>
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Level</th>
              <th className="px-3 py-2 text-right">Weekly</th>
              <th className="px-3 py-2 text-right">Season</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={`${t.seasonSlug}-${t.cardId}`} className="border-t border-ink-600">
                <td className="px-3 py-2 text-zinc-400">{t.season.name}</td>
                <td className="px-3 py-2">
                  <Link href={`/team/${t.seasonSlug}/${t.cardId}`} className="hover:text-banana-400">
                    {t.leagueName} · #{t.cardId}
                  </Link>
                  {t.status !== "draft_pass" && (
                    <>
                      {" "}
                      <Link
                        href={`/pod/${t.seasonSlug}/${encodeURIComponent(t.level)}/${encodeURIComponent(t.leagueName)}`}
                        className="text-xs text-zinc-500 hover:text-banana-400"
                      >
                        (pod)
                      </Link>
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-400">{t.level}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {t.latest ? t.latest.weeklyScore.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold">
                  {t.latest ? t.latest.seasonScore.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

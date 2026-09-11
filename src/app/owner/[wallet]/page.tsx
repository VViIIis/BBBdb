import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAllSeasons } from "@/lib/seasons";

export const dynamic = "force-dynamic";

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export default async function OwnerPage({
  params,
  searchParams,
}: {
  params: { wallet: string };
  searchParams: { season?: string };
}) {
  const wallet = params.wallet.toLowerCase();

  const [owner, seasons] = await Promise.all([
    prisma.owner.findUnique({
      where: { wallet },
      include: {
        teams: {
          include: { season: true, scores: { orderBy: { capturedAt: "desc" }, take: 1 } },
        },
      },
    }),
    getAllSeasons(),
  ]);

  if (!owner) notFound();

  // Default to one season at a time (the currently-active one) rather than
  // lumping every season together — different seasons have different scale
  // and field size, so an all-time combined view reads as noise more often
  // than it's useful. ?season=all opts back into the full history view.
  const viewAll = searchParams.season === "all";
  const activeSlug = seasons.find((s) => s.isActive)?.slug ?? seasons[0]?.slug;
  const selectedSlug = viewAll ? null : (searchParams.season ?? activeSlug);

  const allTeams = owner.teams
    .map((t) => ({ ...t, latest: t.scores[0] ?? null }))
    .sort((a, b) => (b.latest?.seasonScore ?? 0) - (a.latest?.seasonScore ?? 0));

  const teams = selectedSlug ? allTeams.filter((t) => t.seasonSlug === selectedSlug) : allTeams;

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

      {seasons.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {seasons.map((s) => (
            <Link
              key={s.slug}
              href={`/owner/${owner.wallet}?season=${encodeURIComponent(s.slug)}`}
              className={`rounded-full px-3 py-1 text-sm ${
                !viewAll && selectedSlug === s.slug
                  ? "bg-banana-400 font-semibold text-ink-900"
                  : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
              }`}
            >
              {s.name}
            </Link>
          ))}
          <Link
            href={`/owner/${owner.wallet}?season=all`}
            className={`rounded-full px-3 py-1 text-sm ${
              viewAll ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
            }`}
          >
            All-time
          </Link>
        </div>
      )}

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
              {viewAll && <th className="px-3 py-2">Season</th>}
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Level</th>
              <th className="px-3 py-2 text-right">Weekly</th>
              <th className="px-3 py-2 text-right">Season</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={`${t.seasonSlug}-${t.cardId}`} className="border-t border-ink-600">
                {viewAll && <td className="px-3 py-2 text-zinc-400">{t.season.name}</td>}
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
            {teams.length === 0 && (
              <tr>
                <td colSpan={viewAll ? 5 : 4} className="px-3 py-8 text-center text-zinc-500">
                  No teams for this season.
                </td>
              </tr>
            )}
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

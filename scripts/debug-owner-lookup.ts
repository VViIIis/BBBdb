/**
 * One-off diagnostic, follow-up to debug-unscored.ts: that script's
 * `findFirst({ where: { displayName } })` returned an owner with 0 teams
 * for AceJohn, even though AceJohn clearly has teams (visible on both the
 * leaderboard and advancement pages) — meaning there's very likely more
 * than one Owner row sharing that display name (different wallets), and
 * findFirst grabbed the wrong one. This lists every Owner row whose
 * displayName matches (partial, case-insensitive) along with how many
 * teams each one actually has in the given season, to confirm that and
 * find the wallet that actually holds the teams.
 *
 * Usage: npx tsx scripts/debug-owner-lookup.ts [nameFragment] [seasonSlug]
 *   Defaults: "AceJohn", the active season.
 */
import { prisma } from "../src/lib/db";

async function main() {
  const nameFragment = process.argv[2] ?? "AceJohn";
  const seasonArg = process.argv[3];

  const season = seasonArg
    ? await prisma.season.findUniqueOrThrow({ where: { slug: seasonArg } })
    : await prisma.season.findFirstOrThrow({ where: { isActive: true } });

  const owners = await prisma.owner.findMany({
    where: { displayName: { contains: nameFragment, mode: "insensitive" } },
    select: {
      wallet: true,
      displayName: true,
      firstSeenAt: true,
      lastSeenAt: true,
      _count: { select: { teams: true } },
    },
  });

  console.log(`Owners matching "${nameFragment}" (any season): ${owners.length}\n`);

  for (const o of owners) {
    const teamsThisSeason = await prisma.team.count({
      where: { seasonSlug: season.slug, ownerWallet: o.wallet, status: { not: "draft_pass" } },
    });
    console.log(
      `  wallet=${o.wallet}  displayName=${JSON.stringify(o.displayName)}  ` +
        `totalTeamsAllSeasons=${o._count.teams}  teamsIn(${season.slug})=${teamsThisSeason}  ` +
        `firstSeenAt=${o.firstSeenAt.toISOString()}  lastSeenAt=${o.lastSeenAt.toISOString()}`,
    );
  }

  if (owners.length === 0) {
    console.log("  (no owners matched that name fragment at all)");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

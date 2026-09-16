/**
 * One-off diagnostic: which of an owner's teams (for a season) have NO
 * ScoreSnapshot row at all, and why. Prompted by the advancement page
 * showing e.g. "173/579 (15 unscored)" for AceJohn even though every pod
 * should have been scored by now — this prints exactly which 15 (or
 * however many) teams are missing a snapshot, plus enough context (level,
 * pod, when we first saw the team) to tell "just hasn't synced yet" apart
 * from "something's actually stuck."
 *
 * Usage: npx tsx scripts/debug-unscored.ts [ownerNameOrWallet] [seasonSlug]
 *   Defaults: "AceJohn", the active season.
 */
import { prisma } from "../src/lib/db";

async function main() {
  const ownerArg = process.argv[2] ?? "AceJohn";
  const seasonArg = process.argv[3];

  const season = seasonArg
    ? await prisma.season.findUniqueOrThrow({ where: { slug: seasonArg } })
    : await prisma.season.findFirstOrThrow({ where: { isActive: true } });

  const owner = ownerArg.startsWith("0x")
    ? await prisma.owner.findUnique({ where: { wallet: ownerArg.toLowerCase() } })
    : await prisma.owner.findFirst({ where: { displayName: { equals: ownerArg, mode: "insensitive" } } });

  if (!owner) {
    console.error(`No owner found matching "${ownerArg}"`);
    process.exit(1);
  }

  const teams = await prisma.team.findMany({
    where: { seasonSlug: season.slug, ownerWallet: owner.wallet, status: { not: "draft_pass" } },
    select: {
      cardId: true,
      leagueId: true,
      leagueName: true,
      level: true,
      status: true,
      firstSeenAt: true,
      lastSeenAt: true,
      _count: { select: { scores: true } },
    },
    orderBy: { firstSeenAt: "asc" },
  });

  const unscored = teams.filter((t) => t._count.scores === 0);

  console.log(`Owner: ${owner.displayName ?? owner.wallet} (${owner.wallet})`);
  console.log(`Season: ${season.slug} — ${teams.length} total teams, ${unscored.length} unscored\n`);

  for (const t of unscored) {
    console.log(
      `  cardId=${t.cardId}  level=${t.level}  leagueId=${t.leagueId}  leagueName=${t.leagueName}  ` +
        `status=${t.status}  firstSeenAt=${t.firstSeenAt.toISOString()}  lastSeenAt=${t.lastSeenAt.toISOString()}`,
    );
  }

  if (unscored.length === 0) {
    console.log("  (none — every team has at least one ScoreSnapshot)");
    return;
  }

  // For each unscored team's POD, show whether ANY teammate in that same
  // pod has a score — if podmates are scored but this team isn't, that
  // points at something wrong with this specific team/cardId rather than
  // "the pod hasn't been scored yet at all."
  console.log("\nPod context (does anyone else in the same pod have a score?):");
  for (const t of unscored) {
    const podScored = await prisma.scoreSnapshot.count({
      where: { seasonSlug: season.slug, team: { leagueId: t.leagueId } },
    });
    const podTeamCount = await prisma.team.count({
      where: { seasonSlug: season.slug, leagueId: t.leagueId, status: { not: "draft_pass" } },
    });
    console.log(
      `  leagueId=${t.leagueId} (${t.leagueName}): ${podTeamCount} teams in pod, ` +
        `${podScored} score rows exist across the whole pod`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

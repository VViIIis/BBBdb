import "dotenv/config";
/**
 * One-off diagnostic, purely against our own DB (no OpenSea calls needed):
 * spotted a team named "HOF #99 (from Wheel) · #13778" on the leaderboard,
 * which looks like SBS's own naming convention for a promo-wheel-spin entry
 * vs. the standard "BBB #NNN" paid-bracket naming. If that pattern holds up
 * across the whole dataset, we may already have paid-vs-promo sitting in
 * data we've synced, without needing OpenSea trait/mint-transaction digging.
 *
 * Run with: npx tsx scripts/check-league-names.ts
 */
import { prisma } from "../src/lib/db";

async function main() {
  const total = await prisma.team.count({ where: { status: "active" } });
  const wheelCount = await prisma.team.count({
    where: { status: "active", leagueName: { contains: "Wheel", mode: "insensitive" } },
  });
  console.log(`Active (drafted) teams: ${total}`);
  console.log(`...of which leagueName mentions "Wheel": ${wheelCount}`);

  // Bucket every distinct leagueName by its "shape" (numbers stripped out)
  // so we can see every naming pattern SBS actually uses without printing
  // thousands of individual names.
  const rows = await prisma.team.findMany({
    where: { status: "active" },
    select: { leagueName: true },
  });
  const shapes = new Map<string, number>();
  for (const r of rows) {
    const shape = r.leagueName.replace(/#\d+/g, "#N").replace(/\d+/g, "N");
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  console.log("\nDistinct leagueName patterns (numbers replaced with N), most common first:");
  for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(6)}  ${shape}`);
  }
}

main().finally(() => prisma.$disconnect());

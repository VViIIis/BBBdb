import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const wallet = process.argv[2]?.toLowerCase();
  if (!wallet) throw new Error("pass a wallet address as an arg");

  const owner = await prisma.owner.findUnique({ where: { wallet }, include: { teams: true } });
  console.log("Owner record found:", !!owner);
  if (owner) {
    console.log("displayName:", owner.displayName);
    console.log("teams linked via relation:", owner.teams.length);
  }

  const exactCount = await prisma.team.count({ where: { ownerWallet: wallet } });
  console.log("team.count exact-case match:", exactCount);

  const totalTeams = await prisma.team.count();
  const totalOwners = await prisma.owner.count();
  console.log("total teams in db:", totalTeams);
  console.log("total owners in db:", totalOwners);

  // check for any wallets that look similar but differ in case/whitespace
  const similar = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wallet, COUNT(*) FROM "Owner" WHERE LOWER(wallet) = $1 GROUP BY wallet`,
    wallet
  );
  console.log("owners matching case-insensitively:", similar);
}

main().finally(() => prisma.$disconnect());

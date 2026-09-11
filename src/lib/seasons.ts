import { prisma } from "@/lib/db";

/** Every season, most-recently-active first, for building a season switcher. */
export async function getAllSeasons() {
  return prisma.season.findMany({ orderBy: [{ isActive: "desc" }, { slug: "desc" }] });
}

/**
 * Resolves which season a page/route should use: the one named in the URL
 * if it's real, otherwise whichever Season has isActive=true, otherwise
 * (defensive — shouldn't happen once at least one season is seeded) any
 * season at all.
 */
export async function resolveSeason(slugParam?: string) {
  if (slugParam) {
    const season = await prisma.season.findUnique({ where: { slug: slugParam } });
    if (season) return season;
  }
  const active = await prisma.season.findFirst({ where: { isActive: true } });
  if (active) return active;
  const any = await prisma.season.findFirst();
  if (!any) {
    throw new Error("No seasons configured — seed at least one Season row.");
  }
  return any;
}

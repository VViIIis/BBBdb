import { NextRequest, NextResponse } from "next/server";
import { runSyncLeaderboard } from "@/lib/jobs/syncLeaderboard";

/**
 * Trigger endpoint for Vercel Cron (see vercel.json). Protected by a shared
 * secret so the public internet can't force-refresh your data (or worse,
 * spam sbsfantasy.com's API through your deployment). Vercel Cron sends
 * requests with an `Authorization: Bearer <CRON_SECRET>`-style header
 * automatically when you set CRON_SECRET in your project — this route
 * checks SYNC_SECRET against a query param or header so it also works from
 * a plain `curl`/GitHub Actions call if you'd rather cron it that way.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.SYNC_SECRET;
  const provided =
    req.nextUrl.searchParams.get("secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSyncLeaderboard();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

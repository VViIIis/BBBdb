import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * next/link with prefetching OFF by default. Use this everywhere instead of
 * importing next/link directly.
 *
 * Why (2026-10-07): Vercel paused the site for using more than the Hobby
 * plan's 4 hours of function CPU in a month, on only a few dozen real
 * visitors a day. Next's <Link> prefetches every link as it scrolls into
 * view, and every page here is dynamic, so each prefetch is a separate
 * server function call. The leaderboard alone has ~600 links (owner, team
 * and pod on each of 200 rows), so one visit could trigger hundreds of
 * function calls before the visitor clicked anything. Without prefetch, a
 * click costs one call and the page still loads in well under a second.
 */
export default function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />;
}

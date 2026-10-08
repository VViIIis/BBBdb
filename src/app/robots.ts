import type { MetadataRoute } from "next";

/**
 * Keeps search-engine and AI crawlers to the handful of top-level pages.
 *
 * Every page on this site is built fresh from the database on each request,
 * and there are tens of thousands of per-team / per-owner / per-pod pages,
 * plus every combination of ?season= / ?level= / ?week= / ?sort= filters.
 * A crawler walking all of that burns through the Vercel Hobby plan's
 * monthly function-CPU allowance — which is what got the site paused on
 * 2026-10-07. Real visitors arrive by links (X, SBS Discord) anyway, so
 * nothing is lost by keeping crawlers on the main pages.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/team/", "/owner/", "/pod/", "/api/", "/search", "/*?"],
      },
    ],
  };
}

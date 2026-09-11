import Link from "next/link";

export default function SeasonTabs({
  seasons,
  current,
  basePath,
  extraParams,
}: {
  seasons: { slug: string; name: string }[];
  current: string;
  /** e.g. "/" or "/owners" — season becomes a ?season= query param on this path. */
  basePath: string;
  /** Other query params to preserve alongside `season` (e.g. a search term
   * or filter on a page like /exposure that has more than one). */
  extraParams?: Record<string, string | undefined>;
}) {
  if (seasons.length <= 1) return null; // nothing to switch between yet
  const extra = Object.entries(extraParams ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join("");
  return (
    <div className="flex flex-wrap gap-2">
      {seasons.map((s) => {
        const active = s.slug === current;
        return (
          <Link
            key={s.slug}
            href={`${basePath}?season=${encodeURIComponent(s.slug)}${extra}`}
            className={`rounded-full px-3 py-1 text-sm ${
              active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
            }`}
          >
            {s.name}
          </Link>
        );
      })}
    </div>
  );
}

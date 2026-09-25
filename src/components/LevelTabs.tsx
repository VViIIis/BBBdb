import Link from "next/link";
import { KNOWN_LEVELS } from "@/lib/sbsApi";

export default function LevelTabs({
  current,
  extraParams,
}: {
  current: string;
  /** Other query params to keep when switching level (season, week). Before
   * this, clicking a level tab while viewing BBB III jumped back to BBB IV. */
  extraParams?: Record<string, string | undefined>;
}) {
  const tabs = ["all", ...KNOWN_LEVELS];
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {tabs.map((tab) => {
        const active = tab === current;
        const params = new URLSearchParams();
        if (tab !== "all") params.set("level", tab);
        for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
        const qs = params.toString();
        const href = qs ? `/?${qs}` : "/";
        return (
          <Link
            key={tab}
            href={href}
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm ${
              active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
            }`}
          >
            {tab === "all" ? "All" : tab}
          </Link>
        );
      })}
    </div>
  );
}

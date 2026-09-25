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
    <div className="flex flex-wrap gap-2">
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
            className={`rounded-full px-3 py-1 text-sm ${
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

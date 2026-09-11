import Link from "next/link";
import { KNOWN_LEVELS } from "@/lib/sbsApi";

export default function LevelTabs({ current }: { current: string }) {
  const tabs = ["all", ...KNOWN_LEVELS];
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab === current;
        const href = tab === "all" ? "/" : `/?level=${encodeURIComponent(tab)}`;
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

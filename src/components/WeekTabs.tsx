import Link from "next/link";

export default function WeekTabs({
  weeks,
  current,
}: {
  /** Most recent first — caller decides how many to show (the /scores page slices to a handful). */
  weeks: { season: number; week: number }[];
  current: { season: number; week: number };
}) {
  if (weeks.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {weeks.map((w) => {
        const active = w.season === current.season && w.week === current.week;
        return (
          <Link
            key={`${w.season}-${w.week}`}
            href={`/scores?season=${w.season}&week=${w.week}`}
            className={`rounded-full px-3 py-1 text-sm ${
              active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
            }`}
          >
            Week {w.week}
          </Link>
        );
      })}
    </div>
  );
}

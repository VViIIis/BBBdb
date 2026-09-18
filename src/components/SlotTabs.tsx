import Link from "next/link";

const SLOTS = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "DST"] as const;
export type StatsSlot = (typeof SLOTS)[number];

export function isStatsSlot(v: string | undefined): v is StatsSlot {
  return !!v && (SLOTS as readonly string[]).includes(v);
}

function label(slot: StatsSlot) {
  return slot === "DST" ? "D/ST" : slot;
}

export default function SlotTabs({ season, current }: { season: number; current: StatsSlot }) {
  return (
    <div className="flex flex-wrap gap-2">
      {SLOTS.map((slot) => {
        const active = slot === current;
        return (
          <Link
            key={slot}
            href={`/stats?season=${season}&slot=${slot}`}
            className={`rounded-full px-3 py-1 text-sm ${
              active ? "bg-banana-400 font-semibold text-ink-900" : "bg-ink-800 text-zinc-300 hover:bg-ink-700"
            }`}
          >
            {label(slot)}
          </Link>
        );
      })}
    </div>
  );
}

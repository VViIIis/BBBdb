// One game's SBS "Team Positions" box score card — same visual language
// (ink/banana palette, position-slot rows) as the one-off social graphics
// built with this project's Design artifacts, translated to the app's own
// Tailwind-only styling (no inline styles anywhere else in this codebase).
//
// Only a "final" game ever has slot rows (see syncScores.ts's docblock for
// why final-only is intentional, not a gap) — a scheduled/in-progress game
// still gets a card, just a minimal one, so the week view always shows a
// complete slate.

const SLOT_ORDER = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "DST"] as const;

export interface GameBoxScoreCardSlot {
  team: string;
  slot: string;
  playerName: string | null;
  statLine: string;
  points: number;
}

export interface GameBoxScoreCardGame {
  espnEventId: string;
  kickoff: Date;
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
  status: string;
  slots: GameBoxScoreCardSlot[];
}

function fmtPoints(n: number) {
  return n.toFixed(2);
}

function TeamColumn({
  team,
  opponent,
  won,
  score,
  slots,
  highPoints,
}: {
  team: string;
  opponent: string;
  won: boolean | null; // null when scores aren't final/comparable
  score: number | null;
  slots: GameBoxScoreCardSlot[];
  highPoints: number;
}) {
  const byPos = new Map(slots.map((s) => [s.slot, s]));
  const total = slots.reduce((sum, s) => sum + s.points, 0);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink-600 bg-ink-800 p-3">
      <div className="flex items-center justify-between border-b border-ink-600 pb-2">
        <div>
          <div className="font-semibold text-zinc-100">{team}</div>
          {won != null && (
            <div className={`text-xs font-semibold ${won ? "text-emerald-400" : "text-rose-400"}`}>
              {won ? "WIN" : "LOSS"}
              {score != null ? ` · ${score}` : ""}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">SBS total</div>
          <div className="text-lg font-bold text-zinc-100">{fmtPoints(total)}</div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {SLOT_ORDER.map((slotName) => {
          const s = byPos.get(slotName);
          if (!s) return null;
          const isHigh = s.points === highPoints && highPoints > 0;
          return (
            <div
              key={slotName}
              className={`flex items-center gap-3 rounded-md px-2.5 py-1.5 ${
                isHigh ? "bg-ink-700 ring-1 ring-banana-400" : "bg-ink-700"
              }`}
            >
              <div className="w-10 shrink-0 text-center text-xs font-bold text-banana-400">{slotName}</div>
              <div className="min-w-0 flex-grow">
                <div className="truncate text-sm font-medium text-zinc-100">
                  {s.playerName ?? <span className="text-zinc-500">—</span>}
                  {isHigh && (
                    <span className="ml-1.5 rounded-full bg-banana-400 px-1.5 py-0.5 text-[9px] font-bold text-ink-900">
                      HIGH
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-zinc-500">{s.statLine}</div>
              </div>
              <div className={`shrink-0 text-right text-sm font-bold tabular-nums ${isHigh ? "text-banana-400" : "text-zinc-100"}`}>
                {fmtPoints(s.points)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function GameBoxScoreCard({ game }: { game: GameBoxScoreCardGame }) {
  const kickoffLabel = game.kickoff.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  if (game.status !== "final") {
    return (
      <div className="flex items-center justify-between rounded-xl border border-ink-600 bg-ink-800 p-4">
        <div className="font-semibold text-zinc-100">
          {game.awayTeam} @ {game.homeTeam}
        </div>
        <div className="text-sm text-zinc-500">
          {game.status === "in" ? "In progress — box score posts once final" : kickoffLabel}
        </div>
      </div>
    );
  }

  const awaySlots = game.slots.filter((s) => s.team === game.awayTeam);
  const homeSlots = game.slots.filter((s) => s.team === game.homeTeam);
  const awayTotal = awaySlots.reduce((sum, s) => sum + s.points, 0);
  const homeTotal = homeSlots.reduce((sum, s) => sum + s.points, 0);
  const highPoints = Math.max(0, ...game.slots.map((s) => s.points));

  const awayWon = game.awayScore != null && game.homeScore != null ? game.awayScore > game.homeScore : null;
  const realWinnerIsAway = awayWon === true;
  const sbsWinnerIsAway = awayTotal > homeTotal;
  const isUpset = game.awayScore != null && game.homeScore != null && realWinnerIsAway !== sbsWinnerIsAway;

  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-zinc-100">
            {game.awayTeam} {game.awayScore} @ {game.homeTeam} {game.homeScore}
          </div>
          <div className="text-xs text-zinc-500">{kickoffLabel} · Final</div>
        </div>
        {isUpset && (
          <span className="rounded-full bg-banana-400 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-900">
            SBS upset
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TeamColumn
          team={game.awayTeam}
          opponent={game.homeTeam}
          won={awayWon}
          score={game.awayScore}
          slots={awaySlots}
          highPoints={highPoints}
        />
        <TeamColumn
          team={game.homeTeam}
          opponent={game.awayTeam}
          won={awayWon == null ? null : !awayWon}
          score={game.homeScore}
          slots={homeSlots}
          highPoints={highPoints}
        />
      </div>
    </div>
  );
}

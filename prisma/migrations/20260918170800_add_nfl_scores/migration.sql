-- CreateTable
CREATE TABLE "NflGame" (
    "espnEventId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "seasonType" INTEGER NOT NULL,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayScore" INTEGER,
    "homeScore" INTEGER,
    "status" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NflGame_pkey" PRIMARY KEY ("espnEventId")
);

-- CreateTable
CREATE TABLE "TeamPositionScore" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "playerName" TEXT,
    "statLine" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "TeamPositionScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NflGame_season_week_idx" ON "NflGame"("season", "week");

-- CreateIndex
CREATE INDEX "NflGame_status_idx" ON "NflGame"("status");

-- CreateIndex
CREATE INDEX "TeamPositionScore_gameId_idx" ON "TeamPositionScore"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamPositionScore_gameId_team_slot_key" ON "TeamPositionScore"("gameId", "team", "slot");

-- AddForeignKey
ALTER TABLE "TeamPositionScore" ADD CONSTRAINT "TeamPositionScore_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "NflGame"("espnEventId") ON DELETE RESTRICT ON UPDATE CASCADE;

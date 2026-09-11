-- CreateTable
CREATE TABLE "Owner" (
    "wallet" TEXT NOT NULL,
    "displayName" TEXT,
    "imageUrl" TEXT,
    "equippedBadge" TEXT,
    "ripenessTier" INTEGER,
    "ripenessLabel" TEXT,
    "ripenessCount" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "Team" (
    "cardId" TEXT NOT NULL,
    "teamNumber" INTEGER,
    "leagueId" TEXT NOT NULL,
    "leagueName" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "ownerWallet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("cardId")
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL,
    "teamCardId" TEXT NOT NULL,
    "gameweek" TEXT NOT NULL,
    "rank" INTEGER,
    "weeklyScore" DOUBLE PRECISION NOT NULL,
    "seasonScore" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "recordCount" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "errorText" TEXT,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Owner_displayName_idx" ON "Owner"("displayName");

-- CreateIndex
CREATE INDEX "Team_ownerWallet_idx" ON "Team"("ownerWallet");

-- CreateIndex
CREATE INDEX "Team_leagueId_idx" ON "Team"("leagueId");

-- CreateIndex
CREATE INDEX "Team_level_idx" ON "Team"("level");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_gameweek_idx" ON "ScoreSnapshot"("gameweek");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_teamCardId_idx" ON "ScoreSnapshot"("teamCardId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreSnapshot_teamCardId_gameweek_key" ON "ScoreSnapshot"("teamCardId", "gameweek");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_ownerWallet_fkey" FOREIGN KEY ("ownerWallet") REFERENCES "Owner"("wallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_teamCardId_fkey" FOREIGN KEY ("teamCardId") REFERENCES "Team"("cardId") ON DELETE RESTRICT ON UPDATE CASCADE;

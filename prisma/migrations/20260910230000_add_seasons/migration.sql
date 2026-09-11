-- Hand-written (not `prisma migrate dev`'s auto-diff) so we control the
-- ordering: the Season table must exist AND contain the 'bbb4' row BEFORE
-- we add the now-required seasonSlug foreign-key column to Team/
-- ScoreSnapshot, otherwise backfilling existing rows with DEFAULT 'bbb4'
-- would violate the foreign key the moment it's added.

-- CreateTable
CREATE TABLE "Season" (
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("slug")
);

-- Seed the current live season. Every Team/ScoreSnapshot row that already
-- exists in this database predates seasons entirely, so it's implicitly
-- BBB IV — that's what the DEFAULT 'bbb4' below relies on.
INSERT INTO "Season" ("slug", "name", "chain", "contract", "isActive")
VALUES ('bbb4', 'Banana Best Ball IV', 'base', '0xadf5b9b46616de6d073f226e7b7c532ae2cffb80', true);

-- AlterTable: give every existing Team a season
ALTER TABLE "Team" ADD COLUMN "seasonSlug" TEXT NOT NULL DEFAULT 'bbb4';

-- AlterTable: ScoreSnapshot needs the same season scoping to keep its
-- reference to Team meaningful
ALTER TABLE "ScoreSnapshot" ADD COLUMN "seasonSlug" TEXT NOT NULL DEFAULT 'bbb4';

-- Drop the OLD cardId-only FK/unique-index BEFORE touching Team's primary
-- key — Postgres won't let you drop Team_pkey while ScoreSnapshot's FK
-- still depends on the index backing it (confirmed live: "cannot drop
-- constraint Team_pkey ... other objects depend on it").
ALTER TABLE "ScoreSnapshot" DROP CONSTRAINT "ScoreSnapshot_teamCardId_fkey";
DROP INDEX "ScoreSnapshot_teamCardId_gameweek_key";

-- Now safe: cardId is only unique WITHIN a season now that a second
-- collection exists
ALTER TABLE "Team" DROP CONSTRAINT "Team_pkey";
ALTER TABLE "Team" ADD CONSTRAINT "Team_pkey" PRIMARY KEY ("seasonSlug", "cardId");

-- Re-add the season-scoped FK/unique-index against the new composite pkey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_teamCardId_fkey" FOREIGN KEY ("seasonSlug", "teamCardId") REFERENCES "Team"("seasonSlug", "cardId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ScoreSnapshot_seasonSlug_teamCardId_gameweek_key" ON "ScoreSnapshot"("seasonSlug", "teamCardId", "gameweek");

-- AddForeignKey: Team -> Season
ALTER TABLE "Team" ADD CONSTRAINT "Team_seasonSlug_fkey" FOREIGN KEY ("seasonSlug") REFERENCES "Season"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Team_seasonSlug_idx" ON "Team"("seasonSlug");

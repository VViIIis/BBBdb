-- DropIndex
DROP INDEX "ScoreSnapshot_teamCardId_idx";

-- CreateIndex
CREATE INDEX "ScoreSnapshot_seasonSlug_teamCardId_idx" ON "ScoreSnapshot"("seasonSlug", "teamCardId");

-- RenameForeignKey
ALTER TABLE "ScoreSnapshot" RENAME CONSTRAINT "ScoreSnapshot_teamCardId_fkey" TO "ScoreSnapshot_seasonSlug_teamCardId_fkey";

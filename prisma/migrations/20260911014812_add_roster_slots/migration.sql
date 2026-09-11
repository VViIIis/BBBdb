-- CreateTable
CREATE TABLE "RosterSlot" (
    "id" TEXT NOT NULL,
    "seasonSlug" TEXT NOT NULL,
    "teamCardId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "RosterSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RosterSlot_seasonSlug_value_idx" ON "RosterSlot"("seasonSlug", "value");

-- CreateIndex
CREATE INDEX "RosterSlot_value_idx" ON "RosterSlot"("value");

-- CreateIndex
CREATE UNIQUE INDEX "RosterSlot_seasonSlug_teamCardId_slot_key" ON "RosterSlot"("seasonSlug", "teamCardId", "slot");

-- AddForeignKey
ALTER TABLE "RosterSlot" ADD CONSTRAINT "RosterSlot_seasonSlug_teamCardId_fkey" FOREIGN KEY ("seasonSlug", "teamCardId") REFERENCES "Team"("seasonSlug", "cardId") ON DELETE RESTRICT ON UPDATE CASCADE;

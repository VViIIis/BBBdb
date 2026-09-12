-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "collectionSlug" TEXT;

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "seasonSlug" TEXT NOT NULL,
    "teamCardId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT,
    "fromWallet" TEXT NOT NULL,
    "toWallet" TEXT NOT NULL,
    "priceEth" DOUBLE PRECISION,
    "paymentSymbol" TEXT,
    "marketplace" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sale_eventKey_key" ON "Sale"("eventKey");

-- CreateIndex
CREATE INDEX "Sale_seasonSlug_occurredAt_idx" ON "Sale"("seasonSlug", "occurredAt");

-- CreateIndex
CREATE INDEX "Sale_toWallet_idx" ON "Sale"("toWallet");

-- CreateIndex
CREATE INDEX "Sale_fromWallet_idx" ON "Sale"("fromWallet");

-- CreateIndex
CREATE INDEX "Sale_teamCardId_idx" ON "Sale"("teamCardId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_seasonSlug_teamCardId_fkey" FOREIGN KEY ("seasonSlug", "teamCardId") REFERENCES "Team"("seasonSlug", "cardId") ON DELETE RESTRICT ON UPDATE CASCADE;

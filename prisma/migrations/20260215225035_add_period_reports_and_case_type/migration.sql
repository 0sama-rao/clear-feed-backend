-- AlterTable
ALTER TABLE "NewsGroup" ADD COLUMN     "caseType" INTEGER;

-- CreateTable
CREATE TABLE "PeriodReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "summary" TEXT,
    "stats" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodReport_userId_idx" ON "PeriodReport"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodReport_userId_period_key" ON "PeriodReport"("userId", "period");

-- AddForeignKey
ALTER TABLE "PeriodReport" ADD CONSTRAINT "PeriodReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

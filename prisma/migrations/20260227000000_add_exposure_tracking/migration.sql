-- CreateEnum
CREATE TYPE "TechCategory" AS ENUM ('EDGE_DEVICE', 'NETWORK', 'OS', 'APPLICATION', 'CLOUD', 'IDENTITY', 'DATABASE', 'LIBRARY', 'OTHER');

-- CreateEnum
CREATE TYPE "ExposureState" AS ENUM ('VULNERABLE', 'FIXED', 'NOT_APPLICABLE', 'INDIRECT');

-- CreateTable
CREATE TABLE "TechStackItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" TEXT,
    "category" "TechCategory" NOT NULL DEFAULT 'APPLICATION',
    "cpePattern" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechStackItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCVEExposure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cveId" TEXT NOT NULL,
    "articleCveId" TEXT,
    "techStackItemId" TEXT,
    "exposureState" "ExposureState" NOT NULL DEFAULT 'VULNERABLE',
    "autoClassified" BOOLEAN NOT NULL DEFAULT true,
    "matchedCpe" TEXT,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patchedAt" TIMESTAMP(3),
    "remediationDeadline" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "UserCVEExposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "snapDate" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechStackItem_userId_idx" ON "TechStackItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TechStackItem_userId_vendor_product_version_key" ON "TechStackItem"("userId", "vendor", "product", "version");

-- CreateIndex
CREATE INDEX "UserCVEExposure_userId_exposureState_idx" ON "UserCVEExposure"("userId", "exposureState");

-- CreateIndex
CREATE UNIQUE INDEX "UserCVEExposure_userId_cveId_key" ON "UserCVEExposure"("userId", "cveId");

-- CreateIndex
CREATE INDEX "PeriodSnapshot_userId_period_snapDate_idx" ON "PeriodSnapshot"("userId", "period", "snapDate");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodSnapshot_userId_period_snapDate_key" ON "PeriodSnapshot"("userId", "period", "snapDate");

-- AddForeignKey
ALTER TABLE "TechStackItem" ADD CONSTRAINT "TechStackItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCVEExposure" ADD CONSTRAINT "UserCVEExposure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCVEExposure" ADD CONSTRAINT "UserCVEExposure_articleCveId_fkey" FOREIGN KEY ("articleCveId") REFERENCES "ArticleCVE"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCVEExposure" ADD CONSTRAINT "UserCVEExposure_techStackItemId_fkey" FOREIGN KEY ("techStackItemId") REFERENCES "TechStackItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

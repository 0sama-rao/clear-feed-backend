-- AlterTable
ALTER TABLE "Article" ADD COLUMN "cvesExtracted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ArticleCVE" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "cveId" TEXT NOT NULL,
    "cvssScore" DOUBLE PRECISION,
    "severity" TEXT,
    "description" TEXT,
    "cpeMatches" JSONB,
    "publishedDate" TIMESTAMP(3),
    "inKEV" BOOLEAN NOT NULL DEFAULT false,
    "kevDateAdded" TIMESTAMP(3),
    "kevDueDate" TIMESTAMP(3),
    "kevRansomwareUse" TEXT,
    "enrichedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleCVE_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArticleCVE_cveId_idx" ON "ArticleCVE"("cveId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleCVE_articleId_cveId_key" ON "ArticleCVE"("articleId", "cveId");

-- AddForeignKey
ALTER TABLE "ArticleCVE" ADD CONSTRAINT "ArticleCVE_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

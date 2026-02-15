-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('COMPANY', 'PERSON', 'PRODUCT', 'GEOGRAPHY', 'SECTOR');

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "author" TEXT,
ADD COLUMN     "cleanText" TEXT,
ADD COLUMN     "entitiesExtracted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "externalLinks" TEXT[],
ADD COLUMN     "guid" TEXT,
ADD COLUMN     "rawHtml" TEXT,
ADD COLUMN     "tags" TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "industryId" TEXT,
ADD COLUMN     "onboarded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UserArticle" ADD COLUMN     "newsGroupId" TEXT;

-- CreateTable
CREATE TABLE "Industry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Industry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndustrySignal" (
    "id" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndustrySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndustryDefaultSource" (
    "id" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,

    CONSTRAINT "IndustryDefaultSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndustryDefaultKeyword" (
    "id" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    "word" TEXT NOT NULL,

    CONSTRAINT "IndustryDefaultKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleEntity" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "ArticleEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleSignal" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "industrySignalId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "ArticleSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "synopsis" TEXT,
    "executiveSummary" TEXT,
    "impactAnalysis" TEXT,
    "actionability" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Industry_name_key" ON "Industry"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Industry_slug_key" ON "Industry"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "IndustrySignal_industryId_slug_key" ON "IndustrySignal"("industryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "IndustryDefaultSource_industryId_url_key" ON "IndustryDefaultSource"("industryId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "IndustryDefaultKeyword_industryId_word_key" ON "IndustryDefaultKeyword"("industryId", "word");

-- CreateIndex
CREATE INDEX "ArticleEntity_articleId_idx" ON "ArticleEntity"("articleId");

-- CreateIndex
CREATE INDEX "ArticleEntity_type_name_idx" ON "ArticleEntity"("type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleSignal_articleId_industrySignalId_key" ON "ArticleSignal"("articleId", "industrySignalId");

-- CreateIndex
CREATE INDEX "NewsGroup_userId_date_idx" ON "NewsGroup"("userId", "date");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserArticle" ADD CONSTRAINT "UserArticle_newsGroupId_fkey" FOREIGN KEY ("newsGroupId") REFERENCES "NewsGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndustrySignal" ADD CONSTRAINT "IndustrySignal_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndustryDefaultSource" ADD CONSTRAINT "IndustryDefaultSource_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndustryDefaultKeyword" ADD CONSTRAINT "IndustryDefaultKeyword_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleEntity" ADD CONSTRAINT "ArticleEntity_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleSignal" ADD CONSTRAINT "ArticleSignal_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleSignal" ADD CONSTRAINT "ArticleSignal_industrySignalId_fkey" FOREIGN KEY ("industrySignalId") REFERENCES "IndustrySignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsGroup" ADD CONSTRAINT "NewsGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

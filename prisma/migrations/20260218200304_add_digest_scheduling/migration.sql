-- AlterTable
ALTER TABLE "User" ADD COLUMN     "digestFrequency" TEXT NOT NULL DEFAULT '1d',
ADD COLUMN     "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastDigestAt" TIMESTAMP(3);

-- AlterTable: per-workspace operator drain switch (isolated send suppression).
ALTER TABLE "Workspace" ADD COLUMN     "sendSuppressed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sendSuppressedReason" TEXT;

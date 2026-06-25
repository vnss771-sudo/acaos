-- AlterTable: progressive MFA lockout counters on User.
ALTER TABLE "User" ADD COLUMN     "failedMfaAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaLockedUntil" TIMESTAMP(3);

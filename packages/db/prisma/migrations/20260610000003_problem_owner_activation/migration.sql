-- AlterEnum
-- PostgreSQL requires ADD VALUE outside a transaction block; Prisma handles this automatically.
ALTER TYPE "SignalType" ADD VALUE 'PROBLEM_OWNER_ACTIVATION';

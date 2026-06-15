-- Convert Mission.status, DiscoveryRun.status, OutreachSent.status from free-form
-- text to DB-enforced enums, preserving existing data via in-place casts.

CREATE TYPE "MissionStatus" AS ENUM ('DRAFT', 'DISCOVERING', 'REVIEWING', 'ACTIVE', 'PAUSED', 'COMPLETE');
ALTER TABLE "Mission" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Mission" ALTER COLUMN "status" TYPE "MissionStatus" USING ("status"::"MissionStatus");
ALTER TABLE "Mission" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE TYPE "DiscoveryRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');
ALTER TABLE "DiscoveryRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "DiscoveryRun" ALTER COLUMN "status" TYPE "DiscoveryRunStatus" USING ("status"::"DiscoveryRunStatus");
ALTER TABLE "DiscoveryRun" ALTER COLUMN "status" SET DEFAULT 'RUNNING';

CREATE TYPE "SendStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'BOUNCED', 'REPLIED');
ALTER TABLE "OutreachSent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OutreachSent" ALTER COLUMN "status" TYPE "SendStatus" USING ("status"::"SendStatus");
ALTER TABLE "OutreachSent" ALTER COLUMN "status" SET DEFAULT 'SENT';

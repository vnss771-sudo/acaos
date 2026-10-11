-- Referral partners: attribute a workspace to the partner whose code was used at signup.
CREATE TABLE "ReferralPartner" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "commissionPercent" INTEGER NOT NULL DEFAULT 20,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralPartner_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralPartner_code_key" ON "ReferralPartner"("code");

ALTER TABLE "Workspace" ADD COLUMN "referralPartnerId" TEXT;
CREATE INDEX "Workspace_referralPartnerId_idx" ON "Workspace"("referralPartnerId");
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_referralPartnerId_fkey" FOREIGN KEY ("referralPartnerId") REFERENCES "ReferralPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReferralPartner" ADD CONSTRAINT "ReferralPartner_commission_check" CHECK ("commissionPercent" BETWEEN 0 AND 100);
ALTER TABLE "ReferralPartner" ADD CONSTRAINT "ReferralPartner_status_check" CHECK ("status" IN ('active', 'paused'));

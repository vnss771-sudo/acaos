-- Billing entitlement grace and Stripe event ordering (UQ-26).
ALTER TABLE "Workspace"
  ADD COLUMN "billingGraceUntil" TIMESTAMP(3),
  ADD COLUMN "billingLastStripeEventAt" TIMESTAMP(3);

-- Workspaces already past_due get the same bounded grace a new lapse would,
-- rather than being dropped to Free the moment this ships.
UPDATE "Workspace" SET "billingGraceUntil" = NOW() + INTERVAL '7 days'
WHERE "subscriptionStatus" = 'past_due';

-- Money columns move from dollars (DoublePrecision) to integer cents.
-- Convert existing values by rounding dollars * 100; the USING clause keeps any
-- existing data correct rather than truncating it.

ALTER TABLE "Prospect"
  ALTER COLUMN "estimatedRevenue" SET DATA TYPE INTEGER USING round("estimatedRevenue" * 100),
  ALTER COLUMN "expectedDealValue" SET DATA TYPE INTEGER USING round("expectedDealValue" * 100);

ALTER TABLE "ProspectOutcome"
  ALTER COLUMN "dealValue" SET DATA TYPE INTEGER USING round("dealValue" * 100);

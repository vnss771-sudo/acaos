-- Add prospectPageToken to Prospect for public brief page links
ALTER TABLE "Prospect" ADD COLUMN "prospectPageToken" TEXT;
CREATE UNIQUE INDEX "Prospect_prospectPageToken_key" ON "Prospect"("prospectPageToken");

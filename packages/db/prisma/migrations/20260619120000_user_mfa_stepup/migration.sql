-- MFA (TOTP) + step-up auth fields on User. All additive and nullable/defaulted
-- so existing accounts are unaffected (MFA off, no recent-reauth requirement met
-- until they next authenticate). totpSecret holds an encrypted blob, not plaintext.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "lastReauthAt" TIMESTAMP(3);

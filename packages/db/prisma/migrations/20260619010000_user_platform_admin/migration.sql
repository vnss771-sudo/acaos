-- Platform-admin flag for the cross-tenant /api/admin panel. Additive, defaulted
-- false so no existing account gains admin access.
ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Sign in with Google / Microsoft for the workspace mailbox (lib/mailOAuth.ts). Additive only.
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "authMethod" TEXT NOT NULL DEFAULT 'PASSWORD';
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "oauthAccountEmail" TEXT;
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "oauthRefreshToken" TEXT;
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "oauthConnectedAt" TIMESTAMP(3);
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "oauthError" TEXT;

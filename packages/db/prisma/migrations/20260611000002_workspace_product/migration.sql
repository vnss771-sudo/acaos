-- WorkspaceProduct: stores product context for AI prompt personalisation
CREATE TABLE "WorkspaceProduct" (
  "id"              TEXT     NOT NULL,
  "workspaceId"     TEXT     NOT NULL,
  "productName"     TEXT     NOT NULL DEFAULT 'field operations software',
  "productCategory" TEXT,
  "targetICP"       TEXT,
  "keyPainPoints"   TEXT[]   NOT NULL DEFAULT '{}',
  "differentiators" TEXT[]   NOT NULL DEFAULT '{}',
  "ctaType"         TEXT     NOT NULL DEFAULT 'book_call',
  "calendarUrl"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceProduct_workspaceId_key"
  ON "WorkspaceProduct"("workspaceId");

ALTER TABLE "WorkspaceProduct"
  ADD CONSTRAINT "WorkspaceProduct_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

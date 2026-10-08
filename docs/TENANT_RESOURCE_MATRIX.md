# Tenant Resource-ID Enforcement Matrix

UQ-04 introduces a resource-derived tenant boundary for API routes that cannot obtain a workspace from the request body/query. The middleware resolves only the resource ownership fact, verifies membership, hides foreign-resource existence with the same 404 used for a missing resource, and executes downstream handlers inside the existing AsyncLocalStorage tenant context. Action-specific RBAC remains in the route.

| Surface | Resource boundary | Action authorization |
| --- | --- | --- |
| `/api/campaigns/:id/**` | `Campaign.workspaceId` via `tenantResourceScope` | existing campaign permission checks for mutation/send/delete |
| `/api/missions/:id/**` | `Mission.workspaceId` via `tenantResourceScope` | existing mission/admin checks |
| `/api/leads/:id/**` | `Lead.workspaceId` via `tenantResourceScope` | existing lead/admin permission checks |
| `/api/prospects/:id/**` | `Prospect.workspaceId` via `prospectTenantScope` on every id route | existing membership/admin/permission checks |
| `/api/signals/:id/**` | `Signal.workspaceId` via `tenantResourceScope` | existing admin check for deletion |
| `/api/inbox/reply/:replyId/**` | `OutreachSent.workspaceId` via `tenantResourceScope` | existing reply/send policy checks |
| Commercial opportunities | request carries `workspaceId`; all record loads use `findFirst({ id, workspaceId })` | membership/permission check precedes load/mutation |
| Delivery jobs | request carries `workspaceId`; `loadJob()` uses `findFirst({ id, workspaceId })` | `ops:manage` permission precedes load/mutation |
| Ops crew/sites/shifts/roster/alerts | request carries `workspaceId`; resource operations use `findFirst({ id, workspaceId })` | ops permission checks |
| Queue jobs | queue payload carries `workspaceId` or initiating user id | `assertCanReadJob` validates workspace membership/owner |

## Reviewed transitive ID lookups

Some `findUnique({ id })` calls are intentionally retained inside an already-authorized parent/workspace flow—for example an outreach intent under an authorized prospect, a campaign referenced while materializing an authorized prospect intent, or a lead used to resolve a workspace before enqueueing an AI job. `scripts/check-tenant-resources.mjs` pins the reviewed tenant-model lookup counts so a new id-only lookup cannot silently expand this surface; any drift requires explicit review and matrix update.

## Security semantics

- Missing resource and foreign-tenant resource both return 404 at the resource boundary.
- Resource middleware establishes `runInWorkspaceContext(workspaceId, ...)` before downstream Prisma work.
- The Prisma tenant guard remains the defense-in-depth check for multi-row operations within that context.
- Resource scoping proves tenant ownership only; route-specific RBAC still decides whether a member may update, delete, send, close, or otherwise act.

# Workspace RBAC

ACAOS workspaces have three roles, stored on `Membership.role`:
`member` ⊂ `admin` ⊂ `owner` (each inherits everything below it). A separate
platform-level `User.isPlatformAdmin` flag governs the cross-tenant `/api/admin`
routes and is independent of workspace roles.

Authorization is enforced two ways, both over the same role model:

- **Named capabilities** — the explicit permission matrix in
  `apps/api/src/lib/permissions.ts`. Routes call
  `assertWorkspacePermission(userId, workspaceId, '<capability>')`, which resolves
  the caller's role (cached) and throws `403` if the role lacks the capability.
  This is the single source of truth for the table below.
- **Generic data-mutation tier** — `assertMinimumWorkspaceRole(userId, workspaceId,
  'admin')` gates the data-writing routes (campaigns, leads, prospects, missions,
  signals, jobs, packs, discovery, enrichment, outcome recording). Any member can
  read workspace data; mutating it requires at least `admin`.

## Capability matrix

| Capability | member | admin | owner | Where |
|---|:---:|:---:|:---:|---|
| Read workspace data / list members | ✓ | ✓ | ✓ | membership check |
| `workspace:update` (name, slug, sender info) | | ✓ | ✓ | `PATCH /workspaces/:id` |
| `workspace:seed` (onboarding seed) | | ✓ | ✓ | `POST /workspaces/:id/seed` |
| `members:manage` (add/invite/list/cancel invites) | | ✓ | ✓ | `/workspaces/:id/members`, `/invites` |
| `billing:manage` (checkout, status, portal) | | ✓ | ✓ | `/billing/*`, `/workspaces/:id/billing-portal` |
| `email_config:manage` (SMTP/IMAP config) | | ✓ | ✓ | `/workspaces/:id/email-config` |
| `api_keys:manage` (rotate/revoke ingest key) | | ✓ | ✓ | `/workspaces/:id/api-key` |
| `icp:update` (ideal-customer profile) | | ✓ | ✓ | `PUT /workspaces/:id/icp` |
| `mail:send_test` (test email — spends SMTP credits) | | ✓ | ✓ | `POST /mailbox/send-test` |
| Mutate workspace data (admin tier) | | ✓ | ✓ | `assertMinimumWorkspaceRole('admin')` |
| `members:grant_admin` (assign the admin role) | | | ✓ | member add/invite with `role: admin` |
| `members:remove` (remove a member) | | | ✓ | `DELETE /workspaces/:id/members/:userId` |
| `model:reset` (reset the scoring model) | | | ✓ | `POST /outcomes/model/reset` |

The three owner-only capabilities are the privilege-escalation / destructive
actions: only an owner can mint another admin, remove a member, or wipe the
scoring model. Every boundary in this table is pinned by
`tests/lib-permissions.test.ts`.

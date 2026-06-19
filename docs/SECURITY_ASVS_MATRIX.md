# ASVS Control Matrix

A mapping of the OWASP Application Security Verification Standard (ASVS) control
areas to where each is implemented and tested in ACAOS. Scope target: **ASVS
Level 1 with Level 2 session/access-control controls**. Status legend:

- ✅ **Implemented** — present in code and covered by a test.
- 🟡 **Partial** — implemented but with a documented gap or roadmap item.
- ⛔ **Planned** — not yet implemented; tracked below.

| ASVS area | Control | Status | Evidence |
|---|---|---|---|
| V2 Authentication | Password hashing (bcrypt), generic login errors (no user enumeration) | ✅ | `apps/api/src/routes/auth.ts`, `tests/routes-auth-lifecycle.test.ts` |
| V2 Authentication | Email verification + password-reset tokens are single-use and expiring | ✅ | `EmailVerificationToken`, `PasswordResetToken` models |
| V2 Authentication | MFA (TOTP, RFC 6238) for owners & admins; passkeys/WebAuthn future | ✅ | `packages/backend-core/src/lib/totp.ts`, `User.totpSecret`/`totpEnabled`, `/api/auth/mfa/*` + `/api/auth/verify-totp`; `tests/lib-totp.test.ts`, `tests-db/auth-mfa.test.ts` |
| V3 Session | Refresh token in `HttpOnly`, `Secure`, `SameSite` cookie; access token in memory only | ✅ | `apps/api/src/lib/cookies.ts`, `apps/web/src/hooks/useApi.ts` |
| V3 Session | Refresh-token rotation + server-side revocation | ✅ | `RefreshToken` model, `/api/auth/refresh`, `/api/auth/logout` |
| V3 Session | CSRF defense for cookie-authenticated mutations | ✅ | `X-CSRF-Protection` header on refresh/logout |
| V3 Session | Step-up / fresh-auth for admin + billing mutations | ✅ | `requireFreshAuth`/`hasFreshAuth` in `apps/api/src/middleware/auth.ts`, `/api/auth/reauth` (`User.lastReauthAt`, `STEP_UP_MAX_AGE_MIN`); `tests-db/auth-mfa.test.ts`, `tests/lib-jwt-scoped.test.ts` |
| V4 Access control | Tenant isolation on every workspace-scoped route | ✅ | `userBelongsToWorkspace` / `userHasWorkspaceAccess`; `tests/multi-tenancy-stress.test.ts`, `tests/security-isolation.test.ts` |
| V4 Access control | RBAC (owner/admin/member); billing & outcomes require admin | ✅ | `assertMinimumWorkspaceRole`; `tests/routes-rbac-admin-gates.test.ts` |
| V4 Access control | Platform-admin gate is a non-user-settable DB flag, not an env var | ✅ | `User.isPlatformAdmin`, `apps/api/src/routes/admin.ts`; surfaced via `/api/auth/me` |
| V5 Validation | Every request body/query validated with Zod before use | ✅ | `apps/api/src/lib/validate.ts` (`parseBody`/`parseQuery`/`parseParams`), per-route schemas |
| V5 Validation | AI/model output schema-validated before any DB write | ✅ | `packages/backend-core/src/lib/aiSchemas.ts`, `tests/lib-ai-schemas.test.ts` |
| V5 Validation | Queue payloads schema-validated at the worker boundary | ✅ | `packages/backend-core/src/lib/queueSchemas.ts`, `tests/lib-queue-schemas.test.ts` |
| V5 Validation | Output encoding / HTML escaping for untrusted strings | ✅ | `tests/security-adversarial.test.ts` (XSS escape cases) |
| V7 Errors & logging | Central typed errors; bounded messages; append-only audit log | ✅ | `ApiError`, `apps/api/src/lib/audit.ts`, `AuditEvent` model |
| V8 Data protection | Mailbox credentials encrypted at rest | ✅ | `EMAIL_ENCRYPTION_KEY`; `WorkspaceEmailConfig` |
| V8 Data protection | Data retention & tenant deletion/export policy | ✅ | `docs/DATA_RETENTION.md`; automated enforcement via the daily `retention-purge` worker job (`purgeExpiredData` in `packages/backend-core/src/lib/retention.ts`, `tests-db/retention.test.ts`) |
| V9 Communications | TLS-only cookies; HSTS and security headers | ✅ | `apps/api/src/middleware/securityHeaders.ts`, `nginx.conf` |
| V10 Malicious code | SSRF guard for user-configured SMTP/IMAP hosts; connect-time DNS pinning closes the rebind TOCTOU | ✅ | `packages/backend-core/src/lib/ssrf.ts` (`resolvePublicMailHost`) wired into `services/mail.ts`; `tests/lib-ssrf.test.ts` |
| V11 Business logic | Idempotency for webhooks & outbound sends | ✅ | `ProcessedStripeEvent`, `ProcessedEmail`, `OutreachSent` unique `(campaignId, leadId)` |
| V12 Files & resources | Ingest batch caps; CSV export bounded & cursor-paginated | ✅ | `apps/api/src/routes/ingest.ts`, `apps/api/src/routes/leads.ts` |
| V13 API | Per-workspace hashed ingest API keys, rotatable/revocable | ✅ | `apps/api/src/routes/ingest.ts`, `docs/KEY_ROTATION.md` |
| V13 API | Rate limiting on auth, AI, mail, and ingest routes | ✅ | `apps/api/src/middleware/rateLimit.ts` |
| V13 API | Webhook signature verification (Stripe) | ✅ | `apps/api/src/routes/billing.ts` |
| V14 Config | Strict Content-Security-Policy (no `unsafe-inline`) | 🟡 | Inline style objects currently require `style-src 'unsafe-inline'`; CSS-token migration is a roadmap item |
| V14 Config | Provider calls bounded (timeout/retry/breaker) with failure metrics | ✅ | `apps/api/src/lib/providerClient.ts`, `tests/lib-provider-client.test.ts` |

## Planned (tracked)

1. **Strict CSP** — migrate inline styles to CSS modules/tokens, drop `style-src 'unsafe-inline'` (V14).
2. **Passkeys / WebAuthn** — a phishing-resistant second factor on top of the shipped TOTP MFA (V2).

## How to keep this matrix honest

This file is review evidence, not aspiration. When you add or change a control,
update the matching row and cite the test. A control without a test is 🟡 at best.

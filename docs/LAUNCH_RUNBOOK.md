# Launch Runbook

## 1. Local bring-up
1. Copy `.env.example` to `.env`
2. Fill in Postgres, Redis, JWT, OpenAI, Stripe, SMTP, and IMAP values
3. Run `npm install`
4. Run `npm run prisma:generate`
5. Run `npm run prisma:migrate`
6. Run `npm run dev:web`, `npm run dev:api`, and `npm run dev:worker`

## 2. Pre-launch checklist
- [ ] Signup and login work end to end
- [ ] Workspace creation works
- [ ] Leads CRUD works
- [ ] AI research endpoint returns valid JSON
- [ ] Outreach generation returns draft content
- [ ] Stripe checkout creates a session
- [ ] Webhook endpoint verifies signatures
- [ ] SMTP sends to a test inbox
- [ ] IMAP sync can read the test inbox
- [ ] Queue worker consumes a test job
- [ ] Prisma migrations applied in staging
- [ ] Admin health endpoint returns green

## 3. Staging
- Deploy Postgres + Redis
- Deploy API
- Deploy worker
- Deploy web
- Point staging Stripe/webhooks to staging URLs
- Test with a real mailbox and a low-volume test workspace

## 4. Production launch day
- Apply production migrations
- Verify environment variables
- Enable Stripe live keys
- Enable OpenAI production key
- Enable SMTP/IMAP production mailbox
- Smoke test auth, lead create, queue create, send, reply analyze
- Watch logs for 60 minutes

## 4b. Pre-launch blockers (config traps that pass dev but break prod)

These are the "works perfectly locally, completely dead in production" failure
modes. Each has been verified against the code; confirm all four before
onboarding any paying user.

- [ ] **`VITE_API_BASE_URL` is set at BUILD time on the web host.** The frontend
  reads `import.meta.env.VITE_API_BASE_URL` and falls back to `''` (same origin).
  Vite inlines env vars at build, not runtime — if it is unset when the static
  bundle is built (e.g. on Vercel), every `/api/*` call hits the static host and
  404s, so the whole app appears broken after login. Set it to the public API
  origin (e.g. `https://api.acaos.app`) before `vite build`.
- [ ] **Web and API are same-site, or cookies are configured for cross-site.**
  The refresh token is an HttpOnly cookie scoped to `/api/auth` with
  `SameSite=Lax` by default. If the web app (`acaos.app`) and API
  (`*.up.railway.app`) are on different sites, the browser won't send the cookie,
  so `/api/auth/refresh` fails and users are logged out on every reload. Fix:
  put the API on a subdomain of the web domain (e.g. `api.acaos.app`), or set
  `COOKIE_SAMESITE=none` (which forces `Secure`) — but `none` requires both sides
  on HTTPS and is increasingly restricted by browsers, so same-site is preferred.
- [ ] **`ALLOWED_ORIGINS` lists the exact web origin(s).** In production CORS
  only allows origins in `ALLOWED_ORIGINS` (falls back to `WEB_URL`). Wildcards
  are intentionally not honored. If unset/wrong, the browser blocks every API
  call cross-origin.
- [ ] **SMTP is live BEFORE onboarding users — or the app is read-only for
  them.** A verified email is required for AI (`/api/ai/*`, admin: all methods via
  `requireVerifiedEmail`) AND for every state-changing request across the data
  routers (POST/PUT/PATCH/DELETE) via `requireVerifiedForMutation` — sends,
  campaigns, mailbox, prospects, leads, missions, signals, billing, etc. Reads
  (GET) stay open, and the onboarding wizard's self-config (`PUT
  /api/workspaces/:id/icp`, `POST /api/workspaces/:id/seed`) is intentionally
  exempt (`requireVerifiedForMutationExcept`) so a new user can finish setup
  before verifying. Verification links are sent via SMTP; if SMTP is not
  configured, signup still succeeds but the verification email is silently skipped
  in production (`auth.ts` `sendVerificationEmail`), so the user can NEVER verify
  and is permanently locked out of every mutation. Either have SMTP live at
  launch, or add an admin/manual verification path first.
  (`/api/auth/resend-verification` only helps once SMTP works.)

## 5. First week metrics
- Signup conversion
- Workspace creation rate
- Lead import count
- AI action usage
- Messages sent
- Reply rate
- Booked calls
- Payment conversion
- Worker failures

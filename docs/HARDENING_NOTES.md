# ACAOS Security & Operational Hardening

Reference for the authorization, abuse-prevention, and operational controls in
the codebase. Linked from [`SECURITY.md`](../SECURITY.md). For deployment and
runbook detail see [`OPERATIONS.md`](OPERATIONS.md).

## Application-level controls

A source-level security assessment surfaced authorization and abuse-prevention
gaps that have since been closed:

- **Billing price authorization** — `/api/billing/checkout` now accepts a
  server-side plan enum (`starter` / `growth`) and resolves the Stripe price id
  itself; a raw client-supplied `priceId` is rejected. The webhook activates the
  exact plan recorded in session metadata and never defaults an unrecognized
  price to a tier.
- **Lead-cap enforcement** — both `/api/ingest` and `/api/leads/import` reserve
  capacity atomically under a per-workspace advisory lock
  (`reserveLeadCapacity`), so a batch cannot push a workspace past its plan cap
  and concurrent batches cannot race past it. Ingest truncates over-cap rows;
  the dashboard import rejects.
- **Unmetered AI** — `/api/jobs/analyze-reply` now requires a billable scope
  (`leadId` or `workspaceId`) and charges AI usage before enqueueing.
- **Revoked ingest keys** — both key rotation and deletion evict the in-memory
  key→workspace cache so a revoked key stops working immediately.
- **SSRF on mail config** — workspace SMTP/IMAP hosts are resolved immediately
  before connecting and rejected if they are, or resolve to, private / loopback
  / link-local / unique-local / CGNAT / metadata addresses (IPv4, IPv6, and
  IPv4-mapped IPv6). See `lib/ssrf.ts`.
- **Outcome data integrity** — `/api/outcomes` verifies the referenced
  `prospectId` / `leadId` belong to the resolved workspace before recording.
- **HTML email injection** — user-controlled values (e.g. workspace names) are
  HTML-escaped before interpolation into email bodies (`lib/html.ts`).

### Operational hardening (deployment responsibility)

- **Redis / BullMQ is a trusted execution boundary.** A client able to write to
  Redis can inject jobs that trigger AI calls or mutate state. Keep Redis on a
  private network (it is not internet-exposed on Railway), require `AUTH` and
  TLS where the provider supports it, and restrict access to the API and worker
  services only. Treat the queue connection string as a secret.
- **Refresh tokens** are currently stored in `localStorage`; migrating them to
  `HttpOnly`, `Secure`, `SameSite` cookies with CSRF protection is tracked as a
  separate follow-up because it is a cross-cutting auth-flow change.
- Run containers as a non-root user, keep database migrations separate from API
  startup, and configure `trust proxy` to match the hosting topology so rate
  limiting keys on the real client IP.

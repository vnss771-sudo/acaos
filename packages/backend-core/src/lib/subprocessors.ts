// Disclosed sub-processor list (GDPR Art. 28 / Art. 13–14 transparency). Every
// external service that may receive personal data, derived from the codebase. This
// is the FACTUAL inventory — the customer-facing legal descriptions/DPAs are layered
// on top by legal, but the list itself is code-truth so it can't silently drift.
//
// Bump SUBPROCESSORS_VERSION whenever an entry is added/removed/materially changed —
// the workspace records which version it acknowledged (Workspace.subprocessorsAckAt
// + subprocessorsAckVersion), so a change can prompt re-acknowledgement.

export const SUBPROCESSORS_VERSION = '2026-06-24'

// Version of the acceptable-use / data-processing terms a workspace accepts. Bump
// when the terms change so existing acceptances can be re-prompted.
export const COMPLIANCE_TERMS_VERSION = '2026-06-24'

// Allowed values (kept here so the API schema and any reporting share one source).
export const LAWFUL_BASES = ['legitimate_interest', 'consent', 'contract'] as const
export const CONSENT_BASES = ['express_consent', 'implied_consent', 'legitimate_interest'] as const
export const CONSENT_SOURCES = ['import', 'manual', 'form', 'crm_sync'] as const

export type Subprocessor = {
  name: string
  purpose: string
  data: string
  // Only engaged when the corresponding capability/config is present.
  conditional?: string
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: 'OpenAI',
    purpose: 'Lead research, outreach generation, reply classification',
    data: 'Business name, contact first name, truncated lead notes, inbound reply bodies',
    conditional: 'AI features enabled (FEATURE_AI)',
  },
  {
    name: 'Stripe',
    purpose: 'Subscription billing',
    data: 'Billing email, workspace identifier',
    conditional: 'Billing configured (STRIPE_SECRET_KEY)',
  },
  {
    name: "Customer's SMTP / IMAP provider",
    purpose: 'Sending outreach and reading replies',
    data: 'Recipient email address and message content',
    conditional: 'Per-workspace email configured',
  },
  {
    name: 'Apollo, Hunter, Google Places',
    purpose: 'Prospect discovery and enrichment',
    data: 'Prospect company and contact data',
    conditional: 'Discovery enabled (FEATURE_DISCOVERY)',
  },
  {
    name: 'Sentry',
    purpose: 'Error monitoring',
    data: 'Error context (HTTP method, route, identifiers) — never request/email bodies',
    conditional: 'SENTRY_DSN configured',
  },
] as const

export type SubprocessorDisclosure = {
  version: string
  subprocessors: readonly Subprocessor[]
}

export function subprocessorDisclosure(): SubprocessorDisclosure {
  return { version: SUBPROCESSORS_VERSION, subprocessors: SUBPROCESSORS }
}

// Data Processing Agreement (GDPR Art. 28) — in-product summary of
// docs/legal/acceptable-use-and-dpa.md Part B, so a customer can actually read
// (and acknowledge) DPA terms without leaving the product. This is the same
// content the markdown template holds; keep the two in sync. Bump DPA_VERSION
// whenever the clauses change so a workspace's prior acknowledgement is flagged
// stale (same pattern as SUBPROCESSORS_VERSION / COMPLIANCE_TERMS_VERSION).
export const DPA_VERSION = '2026-06-24'

export type DpaClause = { title: string; body: string }

export const DPA_CLAUSES: readonly DpaClause[] = [
  {
    title: 'Roles',
    body: 'The customer is the data controller; ACAOS is the data processor. The entities in the sub-processor list above are sub-processors.',
  },
  {
    title: 'Subject-matter & duration',
    body: 'Processing of prospect/recipient personal data for the duration of the subscription.',
  },
  {
    title: 'Nature & purpose',
    body: 'Outreach CRM: lead research, outreach generation, sending, and reply tracking.',
  },
  {
    title: 'Categories of data subjects / data',
    body: 'Business contacts — name, business email, company, derived research, and message content.',
  },
  {
    title: 'Processor obligations (Art. 28(3))',
    body: 'Process only on the customer’s documented instructions; maintain confidentiality; apply the security measures below; flow down sub-processor obligations and disclose changes; assist with data-subject requests and breach notification; delete or return data on termination; allow audits.',
  },
  {
    title: 'Security measures',
    body: 'Encryption in transit (TLS) and of stored mail credentials/TOTP secrets at rest (AES-256-GCM); tenant isolation; RBAC with step-up auth for sensitive actions; retention purge of aged data; access logging and audit events; a documented recovery plan.',
  },
  {
    title: 'Data-subject rights',
    body: 'Per-lead deletion and transactional workspace erasure (DELETE /api/workspaces/:id) support Art. 17 (right to erasure) requests.',
  },
  {
    title: 'Sub-processor changes',
    body: 'Notice is given via the versioned sub-processor disclosure — a material change bumps the version shown above and prompts re-acknowledgement.',
  },
] as const

export type DpaDisclosure = {
  version: string
  clauses: readonly DpaClause[]
}

export function dpaDisclosure(): DpaDisclosure {
  return { version: DPA_VERSION, clauses: DPA_CLAUSES }
}

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

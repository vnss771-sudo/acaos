// Source licence registry and the work-discovery licence gate.
//
// Every work-discovery source (opportunitySources.ts) must have an entry here
// recording what we know about its licence and whether commercial use has been
// confirmed from an authoritative source. The registry is code, not data: a
// change to a licence position is a reviewed commit with its evidence.
//
// The gate (SOURCE_LICENCE_GATE) decides whether the sweep may run a source:
//   unset / ''  → off      the sweep never consults the gate (today's behaviour)
//   'off'       → off
//   'observe'   → runs every source; warns once per sweep for a source that is
//                 unregistered or not commercially confirmed
//   'enforce'   → skips any source that is unregistered or not confirmed
// Any other non-empty value is a configuration error. It fails validateConfig()
// at API boot, and the worker's sweep records it on every source instead of
// fetching (it never silently falls back to `off` or `enforce`).
//
// `enforce` is also a configuration error while a configured source would be
// blocked by it. That stops the gate from switching off live discovery (today:
// AusTender, whose API publishes no licence of its own) as a side effect.

export type CommercialUse = 'confirmed' | 'unverified' | 'prohibited'

export type SourceLicence = {
  /** Matches OpportunitySource.name. */
  source: string
  /** Licence as best established, e.g. 'CC BY 3.0 AU'; 'Unknown' when not established. */
  licence: string
  licenceUrl: string | null
  termsUrl: string
  /** Where the licence position was checked. */
  evidenceUrls: readonly string[]
  /** ISO date (YYYY-MM-DD) of the last review. */
  reviewedAt: string
  commercialUse: CommercialUse
  /** Env var whose presence configures the source on a server; null = needs no key (always configured). */
  configuredBy: string | null
  /** Attribution owed wherever the data is shown. */
  attribution: string
  /** What is and isn't established, in plain words. */
  notes: string
}

export const SOURCE_LICENCES: readonly SourceLicence[] = Object.freeze<SourceLicence[]>([
  Object.freeze({
    source: 'austender',
    licence: 'CC BY 3.0 AU (same data, Finance export); API itself unstated',
    licenceUrl: 'https://creativecommons.org/licenses/by/3.0/au/',
    termsUrl: 'https://www.tenders.gov.au/',
    evidenceUrls: Object.freeze([
      'https://researchdata.edu.au/austender-contract-notice-export/3804931',
      'https://data.open-contracting.org/en/publication/19',
      'https://github.com/austender/austender-ocds-api',
    ]),
    reviewedAt: '2026-10-17',
    commercialUse: 'unverified',
    configuredBy: null,
    attribution: 'Contains AusTender data, Department of Finance, licensed under CC BY 3.0 AU.',
    notes:
      'The Department of Finance publishes the AusTender contract-notice export on data.gov.au under CC BY 3.0 AU, ' +
      'and the Open Contracting registry lists the OCDS publication under the same licence. The OCDS API used here ' +
      '(repository licensed MIT for code only) states no data licence, so commercial use of the API feed is not yet ' +
      'confirmed from Finance directly. Kept unverified until Finance confirms; the gate is off, so discovery is unaffected.',
  }),
  Object.freeze({
    source: 'planningalerts',
    licence: 'Commercial API plan required',
    licenceUrl: null,
    termsUrl: 'https://api.planningalerts.org.au/api/howto',
    evidenceUrls: Object.freeze([
      'https://api.planningalerts.org.au/api/howto',
      'https://www.oaf.org.au/wp-content/uploads/2024/04/PlanningAlerts-API-Supply-Agreement-20240401-1.pdf',
    ]),
    reviewedAt: '2026-10-17',
    commercialUse: 'unverified',
    configuredBy: 'PLANNINGALERTS_API_KEY',
    attribution: 'Data provided by Planning Alerts (https://www.planningalerts.org.au).',
    notes:
      'The free Community plan is for non-commercial use only; commercial use needs the Standard plan ' +
      '(A$3,850/month + GST, checked 16 Oct 2026), which is not held. Not configured in production.',
  }),
])

export type SourceGateMode = 'off' | 'observe' | 'enforce'

export const SOURCE_GATE_MODES: readonly SourceGateMode[] = ['off', 'observe', 'enforce']

export class SourceGateConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceGateConfigError'
  }
}

/** Unset or empty → 'off'. Exact 'off' | 'observe' | 'enforce' only; anything else throws. */
export function parseSourceGateMode(raw: string | undefined): SourceGateMode {
  if (raw === undefined || raw === '') return 'off'
  if ((SOURCE_GATE_MODES as readonly string[]).includes(raw)) return raw as SourceGateMode
  // The value is operator config, not a secret, but it is never echoed: a fixed message is enough to act on.
  throw new SourceGateConfigError(
    `SOURCE_LICENCE_GATE must be unset, empty, 'off', 'observe' or 'enforce'`,
  )
}

export function getSourceLicence(source: string, registry: readonly SourceLicence[] = SOURCE_LICENCES): SourceLicence | undefined {
  return registry.find(l => l.source === source)
}

type GateSource = { name: string; isConfigured: boolean }

/**
 * Configuration problems for the gate, given the server's sources. Empty when the
 * configuration is valid. Pure apart from reading `raw`; safe to call at boot.
 */
export function sourceGateConfigProblems(
  raw: string | undefined,
  sources: readonly GateSource[],
  registry: readonly SourceLicence[] = SOURCE_LICENCES,
): string[] {
  let mode: SourceGateMode
  try {
    mode = parseSourceGateMode(raw)
  } catch (err) {
    return [(err as Error).message]
  }
  if (mode !== 'enforce') return []
  const wouldBlock = sources
    .filter(s => s.isConfigured && getSourceLicence(s.name, registry)?.commercialUse !== 'confirmed')
    .map(s => s.name)
  return wouldBlock.length > 0
    ? [`SOURCE_LICENCE_GATE=enforce would stop configured discovery source(s) without confirmed commercial use: ${wouldBlock.join(', ')}`]
    : []
}

/**
 * Boot-time check for validateConfig(). Uses the registry's `configuredBy` instead of
 * importing the sources, so config.ts stays dependency-light; a unit test keeps
 * `configuredBy` in step with each source's real `isConfigured`.
 */
export function sourceGateBootProblems(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
  registry: readonly SourceLicence[] = SOURCE_LICENCES,
): string[] {
  const sources = registry.map(l => ({ name: l.source, isConfigured: l.configuredBy === null || Boolean(env[l.configuredBy]) }))
  return sourceGateConfigProblems(raw, sources, registry)
}

export type SourceGateDecision =
  | { allow: true; warning?: string }
  | { allow: false; reason: string }

/** Decision for one source under an already-validated mode. */
export function sourceGateDecision(
  source: string,
  mode: SourceGateMode,
  registry: readonly SourceLicence[] = SOURCE_LICENCES,
): SourceGateDecision {
  if (mode === 'off') return { allow: true }
  const entry = getSourceLicence(source, registry)
  const problem = !entry
    ? 'has no licence registry entry'
    : entry.commercialUse === 'confirmed'
      ? null
      : `commercial use is ${entry.commercialUse}`
  if (!problem) return { allow: true }
  if (mode === 'observe') return { allow: true, warning: `Source licence gate (observe): ${source} ${problem}` }
  return { allow: false, reason: `Skipped by the source licence gate: ${source} ${problem}` }
}

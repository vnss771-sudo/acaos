// Model deployment registry (UQ-19). Which model serves customers, which one is
// being shadowed for comparison, and which is recorded as the fallback, all
// from configuration so promotion and rollback are config changes, not code.
//
//   OPENAI_MODEL              ACTIVE: produces every customer-visible result.
//   OPENAI_SHADOW_MODEL       SHADOW: optionally receives a copy of sampled
//                             requests; its output is always discarded.
//   OPENAI_SHADOW_SAMPLE_RATE 0..1 share of requests shadowed (default 0, off).
//   OPENAI_FALLBACK_MODEL     FALLBACK: recorded only. There is deliberately no
//                             automatic fail-over: silent model substitution
//                             would hide compatibility, quality and cost changes.
//
// Every model must be built in or listed in OPENAI_MODEL_ALLOWLIST (the cost
// boundary). A configured model that is not allow-listed is DISABLED; for the
// active slot that means the built-in default serves instead, as before.
import { createHash } from 'node:crypto'
import { BUILTIN_OPENAI_MODELS, DEFAULT_OPENAI_MODEL, modelProfile, type ModelProfile } from './modelProfiles.js'

export type ModelDeploymentState = 'ACTIVE' | 'SHADOW' | 'FALLBACK' | 'DISABLED'

export type ModelDeployment = {
  provider: 'openai'
  model: string
  state: ModelDeploymentState
  profile: ModelProfile
  /** Why a configured model is DISABLED. */
  reason?: string
}

export type ModelRegistry = {
  active: ModelDeployment
  shadow: (ModelDeployment & { sampleRate: number }) | null
  fallback: ModelDeployment | null
  /** Configured models that were not deployed, with the reason. */
  disabled: ModelDeployment[]
}

type Env = Record<string, string | undefined>

function allowList(env: Env): Set<string> {
  return new Set([
    ...BUILTIN_OPENAI_MODELS,
    ...(env.OPENAI_MODEL_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean),
  ])
}

function deployment(model: string, state: ModelDeploymentState, reason?: string): ModelDeployment {
  return { provider: 'openai', model, state, profile: modelProfile(model), ...(reason ? { reason } : {}) }
}

/** Parses a 0..1 share; anything missing, malformed or out of range is 0 (off). */
export function parseSampleRate(raw: string | undefined): number {
  const n = Number((raw ?? '').trim())
  return raw != null && raw.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0
}

export function resolveModelRegistry(env: Env = process.env): ModelRegistry {
  const allowed = allowList(env)
  const disabled: ModelDeployment[] = []
  const notAllowed = (m: string) => `"${m}" is not allow-listed; add it to OPENAI_MODEL_ALLOWLIST`

  const configured = (env.OPENAI_MODEL || '').trim()
  let active = deployment(DEFAULT_OPENAI_MODEL, 'ACTIVE')
  if (configured && allowed.has(configured)) active = deployment(configured, 'ACTIVE')
  else if (configured) disabled.push(deployment(configured, 'DISABLED', notAllowed(configured)))

  const slot = (name: string, state: 'SHADOW' | 'FALLBACK'): ModelDeployment | null => {
    const m = (env[name] || '').trim()
    if (!m || m === active.model) return null
    if (!allowed.has(m)) { disabled.push(deployment(m, 'DISABLED', notAllowed(m))); return null }
    return deployment(m, state)
  }
  const shadowDeployment = slot('OPENAI_SHADOW_MODEL', 'SHADOW')
  const sampleRate = parseSampleRate(env.OPENAI_SHADOW_SAMPLE_RATE)
  const shadow = shadowDeployment && sampleRate > 0 ? { ...shadowDeployment, sampleRate } : null
  if (shadowDeployment && !shadow) disabled.push({ ...shadowDeployment, state: 'DISABLED', reason: 'OPENAI_SHADOW_SAMPLE_RATE is 0' })

  return { active, shadow, fallback: slot('OPENAI_FALLBACK_MODEL', 'FALLBACK'), disabled }
}

/**
 * Deterministic sampling: the same request is always in or out of the sample,
 * so a shadow comparison is reproducible and needs no random number source.
 */
export function inShadowSample(sampleRate: number, ...requestParts: string[]): boolean {
  if (sampleRate <= 0) return false
  if (sampleRate >= 1) return true
  const digest = createHash('sha256').update(requestParts.join('\u0000')).digest()
  return digest.readUInt32BE(0) / 0x1_0000_0000 < sampleRate
}

export function outputHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

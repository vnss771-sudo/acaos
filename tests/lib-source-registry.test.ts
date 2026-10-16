// Unit tests for the source licence registry and the SOURCE_LICENCE_GATE flag
// (no network, no database). The database-backed sweep behaviour lives in
// tests-db/opportunity-sweep.test.ts.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE_LICENCES, getSourceLicence, parseSourceGateMode, sourceGateConfigProblems, sourceGateDecision,
  SourceGateConfigError, sourceGateBootProblems, type SourceLicence,
} from '../packages/backend-core/src/lib/sourceRegistry.ts'
import { OPPORTUNITY_SOURCES } from '../packages/backend-core/src/lib/opportunitySources.ts'
import { validateConfig } from '../packages/backend-core/src/lib/config.ts'

const SAVED = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]
  Object.assign(process.env, SAVED)
})

function licence(source: string, commercialUse: SourceLicence['commercialUse']): SourceLicence {
  return {
    source, licence: 'Test', licenceUrl: null, termsUrl: 'https://example.test/terms',
    evidenceUrls: ['https://example.test/evidence'], reviewedAt: '2026-10-17', commercialUse, configuredBy: null,
    attribution: 'Test attribution', notes: 'Test notes',
  }
}
const REGISTRY: readonly SourceLicence[] = [
  licence('cleared', 'confirmed'), licence('pending', 'unverified'), licence('banned', 'prohibited'),
]

// ── Registry completeness (the guard that makes new sources declare a licence) ─

test('every work-discovery source has exactly one licence registry entry', () => {
  for (const source of OPPORTUNITY_SOURCES) {
    const entries = SOURCE_LICENCES.filter(l => l.source === source.name)
    assert.equal(entries.length, 1, `${source.name} must have exactly one entry in SOURCE_LICENCES (sourceRegistry.ts)`)
  }
})

test('the registry holds no entry for a source that does not exist', () => {
  const names = new Set(OPPORTUNITY_SOURCES.map(s => s.name))
  for (const entry of SOURCE_LICENCES) assert.ok(names.has(entry.source), `stale registry entry: ${entry.source}`)
})

test('every registry entry records its evidence, review date and attribution', () => {
  for (const e of SOURCE_LICENCES) {
    assert.match(e.termsUrl, /^https:\/\//, `${e.source}: termsUrl must be https`)
    if (e.licenceUrl !== null) assert.match(e.licenceUrl, /^https:\/\//, `${e.source}: licenceUrl must be https`)
    assert.ok(e.evidenceUrls.length > 0, `${e.source}: at least one evidence URL`)
    for (const u of e.evidenceUrls) assert.match(u, /^https:\/\//, `${e.source}: evidence URL must be https`)
    assert.match(e.reviewedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(!Number.isNaN(Date.parse(`${e.reviewedAt}T00:00:00Z`)), `${e.source}: reviewedAt must be a real date`)
    assert.ok(['confirmed', 'unverified', 'prohibited'].includes(e.commercialUse))
    assert.ok(e.licence.trim() && e.attribution.trim() && e.notes.trim(), `${e.source}: licence, attribution and notes are required`)
  }
})

test('the registry cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(SOURCE_LICENCES))
  for (const e of SOURCE_LICENCES) assert.ok(Object.isFrozen(e))
})

// AusTender's API publishes no data licence of its own; only the same data via
// Finance's data.gov.au export is CC BY 3.0 AU. Until Finance confirms the API,
// it must not be recorded as cleared. Changing this needs new evidence in the entry.
test('AusTender is recorded as unverified, with the evidence behind that position', () => {
  const e = getSourceLicence('austender')
  assert.ok(e)
  assert.equal(e.commercialUse, 'unverified')
  assert.match(e.notes, /states no data licence/)
  assert.ok(e.evidenceUrls.some(u => u.includes('austender-contract-notice-export')))
})

// ── Mode parsing ──────────────────────────────────────────────────────────────

test('unset or empty SOURCE_LICENCE_GATE means off', () => {
  assert.equal(parseSourceGateMode(undefined), 'off')
  assert.equal(parseSourceGateMode(''), 'off')
})

test('only the exact values off, observe and enforce are accepted', () => {
  assert.equal(parseSourceGateMode('off'), 'off')
  assert.equal(parseSourceGateMode('observe'), 'observe')
  assert.equal(parseSourceGateMode('enforce'), 'enforce')
})

test('any other non-empty value is a configuration error, never a silent fallback', () => {
  for (const bad of ['OFF', 'Enforce', 'enforce ', ' observe', ' ', 'true', 'false', '1', '0', 'on', 'garbage']) {
    assert.throws(() => parseSourceGateMode(bad), (e: Error) => {
      assert.ok(e instanceof SourceGateConfigError)
      // A fixed message: the offending value is never echoed into logs.
      assert.equal(e.message, `SOURCE_LICENCE_GATE must be unset, empty, 'off', 'observe' or 'enforce'`)
      return true
    }, `value ${JSON.stringify(bad)} must be rejected`)
  }
})

// ── Configuration problems ────────────────────────────────────────────────────

test('no problems when the gate is unset, off or observe', () => {
  const sources = [{ name: 'pending', isConfigured: true }, { name: 'unregistered', isConfigured: true }]
  for (const raw of [undefined, '', 'off', 'observe']) assert.deepEqual(sourceGateConfigProblems(raw, sources, REGISTRY), [])
})

test('an invalid value is reported as one configuration problem', () => {
  const problems = sourceGateConfigProblems('bogus', [], REGISTRY)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /SOURCE_LICENCE_GATE must be/)
})

test('enforce is refused while it would stop a configured source that is not confirmed', () => {
  const problems = sourceGateConfigProblems('enforce', [
    { name: 'cleared', isConfigured: true },
    { name: 'pending', isConfigured: true },
    { name: 'unregistered', isConfigured: true },
  ], REGISTRY)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /would stop configured discovery source\(s\).*pending, unregistered/)
})

test('enforce is accepted when every configured source is confirmed (unconfigured ones are ignored)', () => {
  assert.deepEqual(sourceGateConfigProblems('enforce', [
    { name: 'cleared', isConfigured: true },
    { name: 'pending', isConfigured: false },
  ], REGISTRY), [])
})

test('with the real sources, enforce is refused because AusTender is configured and unverified', () => {
  const real = OPPORTUNITY_SOURCES.map(s => ({ name: s.name, isConfigured: s.name === 'austender' ? true : s.isConfigured }))
  const problems = sourceGateConfigProblems('enforce', real)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /austender/)
})

// ── Per-source decisions ──────────────────────────────────────────────────────

test('off allows every source, registered or not, with no warning', () => {
  for (const s of ['cleared', 'pending', 'banned', 'unregistered']) assert.deepEqual(sourceGateDecision(s, 'off', REGISTRY), { allow: true })
})

test('observe allows every source and warns only for ones that are not confirmed', () => {
  assert.deepEqual(sourceGateDecision('cleared', 'observe', REGISTRY), { allow: true })
  for (const s of ['pending', 'banned', 'unregistered']) {
    const d = sourceGateDecision(s, 'observe', REGISTRY)
    assert.equal(d.allow, true)
    assert.ok('warning' in d && d.warning?.includes(s))
  }
})

test('enforce allows confirmed sources and blocks unverified, prohibited and unregistered ones', () => {
  assert.deepEqual(sourceGateDecision('cleared', 'enforce', REGISTRY), { allow: true })
  const expected: Record<string, RegExp> = {
    pending: /pending commercial use is unverified/,
    banned: /banned commercial use is prohibited/,
    unregistered: /unregistered has no licence registry entry/,
  }
  for (const [s, re] of Object.entries(expected)) {
    const d = sourceGateDecision(s, 'enforce', REGISTRY)
    assert.equal(d.allow, false)
    assert.ok(!d.allow && re.test(d.reason))
  }
})

// ── Boot validation ───────────────────────────────────────────────────────────

test('each registry entry\'s configuredBy matches its source\'s real isConfigured, with and without the key', () => {
  for (const source of OPPORTUNITY_SOURCES) {
    const e = getSourceLicence(source.name)!
    if (e.configuredBy === null) {
      assert.equal(source.isConfigured, true, `${source.name} needs no key, so it must always be configured`)
      continue
    }
    const saved = process.env[e.configuredBy]
    try {
      process.env[e.configuredBy] = 'test-key'
      assert.equal(source.isConfigured, true, `${source.name} is configured when ${e.configuredBy} is set`)
      delete process.env[e.configuredBy]
      assert.equal(source.isConfigured, false, `${source.name} is unconfigured when ${e.configuredBy} is unset`)
    } finally {
      if (saved === undefined) delete process.env[e.configuredBy]
      else process.env[e.configuredBy] = saved
    }
  }
})

test('boot check: unset, off and observe are fine; invalid values and enforce-over-AusTender are not', () => {
  for (const raw of [undefined, '', 'off', 'observe']) assert.deepEqual(sourceGateBootProblems(raw, {}), [])
  assert.match(sourceGateBootProblems('Enforce', {})[0] ?? '', /SOURCE_LICENCE_GATE must be/)
  assert.match(sourceGateBootProblems('enforce', {})[0] ?? '', /: austender$/)
  assert.match(sourceGateBootProblems('enforce', { PLANNINGALERTS_API_KEY: 'k' })[0] ?? '', /: austender, planningalerts$/)
})

test('boot check passes enforce when every configured registry source is confirmed', () => {
  const reg = [licence('cleared', 'confirmed'), { ...licence('keyed', 'unverified'), configuredBy: 'KEYED_API_KEY' }]
  assert.deepEqual(sourceGateBootProblems('enforce', {}, reg), [])
  assert.equal(sourceGateBootProblems('enforce', { KEYED_API_KEY: 'k' }, reg).length, 1)
})

test('validateConfig is unaffected when SOURCE_LICENCE_GATE is unset', () => {
  process.env.NODE_ENV = 'development'
  delete process.env.JWT_SECRET
  delete process.env.SOURCE_LICENCE_GATE
  assert.doesNotThrow(() => validateConfig())
})

test('validateConfig fails on an invalid SOURCE_LICENCE_GATE in any environment', () => {
  process.env.NODE_ENV = 'development'
  delete process.env.JWT_SECRET
  process.env.SOURCE_LICENCE_GATE = 'Enforce'
  assert.throws(() => validateConfig(), /SOURCE_LICENCE_GATE must be/)
})

test('validateConfig fails on enforce while AusTender is unverified', () => {
  process.env.NODE_ENV = 'development'
  delete process.env.JWT_SECRET
  process.env.SOURCE_LICENCE_GATE = 'enforce'
  assert.throws(() => validateConfig(), /would stop configured discovery source\(s\).*austender/)
})

test('validateConfig accepts observe', () => {
  process.env.NODE_ENV = 'development'
  delete process.env.JWT_SECRET
  process.env.SOURCE_LICENCE_GATE = 'observe'
  assert.doesNotThrow(() => validateConfig())
})

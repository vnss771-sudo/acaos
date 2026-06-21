/**
 * Email-verification enforcement matrix.
 *
 * Decided policy: an unverified account may authenticate and READ, but every
 * state-changing request (POST/PUT/PATCH/DELETE) on a user-facing data router
 * must clear email verification first. Enforcement is centralized in
 * `requireVerifiedForMutation` (method-aware) applied per router, plus AI/admin
 * which gate ALL methods via `requireVerifiedEmail`.
 *
 * These are static source gates: cheap regression guards so a NEW router (or a
 * refactor that drops the middleware) can't silently ship an ungated mutation.
 * Behavioral proof (real 403 vs pass, reads unaffected) lives in
 * tests-db/verified-email-gate.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, 'apps/api/src/routes', p), 'utf8')

// User-facing data routers that mount the mutation gate at the router level
// (one `requireVerifiedForMutation` covering every mutating route they expose).
const ROUTER_LEVEL_GATED = [
  'missions.ts', 'signals.ts', 'leads.ts', 'packs.ts', 'intelligence.ts',
  'campaigns.ts', 'mailbox.ts', 'sends.ts', 'inbox.ts', 'stats.ts', 'jobs.ts',
  'prospects/index.ts',
]

for (const file of ROUTER_LEVEL_GATED) {
  test(`verification gate: ${file} mounts requireVerifiedForMutation at the router level`, () => {
    const src = read(file)
    assert.match(src, /\.use\(requireVerifiedForMutation\)/, `${file} must apply requireVerifiedForMutation via router.use`)
    // The gate must come AFTER requireAuth so req.user is populated when it runs.
    const authIdx = src.indexOf('.use(requireAuth)')
    const gateIdx = src.indexOf('.use(requireVerifiedForMutation)')
    assert.ok(authIdx !== -1 && gateIdx !== -1 && authIdx < gateIdx, `${file} must mount the gate after requireAuth`)
  })
}

// Per-route gated mutations on routers whose auth is applied per-route (so a
// blanket router-level gate would run before req.user exists).
const PER_ROUTE_GATED: Array<{ file: string; routePath: string }> = [
  { file: 'billing.ts', routePath: "'/checkout'" },
  { file: 'billing.ts', routePath: "'/portal'" },
  { file: 'outcomes.ts', routePath: "'/model/reset'" },
]

for (const { file, routePath } of PER_ROUTE_GATED) {
  test(`verification gate: ${file} ${routePath} requires verification before the handler`, () => {
    const src = read(file)
    const at = src.indexOf(routePath)
    assert.notEqual(at, -1, `could not locate route ${routePath} in ${file}`)
    // Look at the middleware chain declared between this route path and the next
    // route registration (the asyncHandler boundary is enough to bound it).
    const handlerIdx = src.indexOf('asyncHandler', at)
    const chain = src.slice(at, handlerIdx)
    assert.match(chain, /requireVerifiedForMutation/, `${file} ${routePath} must list requireVerifiedForMutation before its handler`)
  })
}

// The workspace router gates mutations too, but exempts the onboarding wizard's
// self-config (PUT /:id/icp, POST /:id/seed) so a not-yet-verified user can finish
// setup. Decided policy: onboarding stays open; everything else stays gated.
test('verification gate: workspaces/index.ts gates mutations except onboarding (icp/seed)', () => {
  const src = read('workspaces/index.ts')
  assert.match(src, /\.use\(requireVerifiedForMutationExcept\(/, 'workspaces must mount the onboarding-exempt mutation gate')
  assert.match(src, /\/icp\$/, 'PUT /:id/icp must be exempt for onboarding')
  assert.match(src, /\/seed\$/, 'POST /:id/seed must be exempt for onboarding')
  const authIdx = src.indexOf('.use(requireAuth)')
  const gateIdx = src.indexOf('.use(requireVerifiedForMutationExcept(')
  assert.ok(authIdx !== -1 && gateIdx !== -1 && authIdx < gateIdx, 'gate must mount after requireAuth')
})

// AI and admin gate EVERY method (not just mutations) with requireVerifiedEmail —
// an unverified user has no business reading admin or invoking AI either.
for (const file of ['ai.ts', 'admin.ts']) {
  test(`verification gate: ${file} gates all methods with requireVerifiedEmail`, () => {
    const src = read(file)
    assert.match(src, /\.use\(requireVerifiedEmail\)/, `${file} must apply requireVerifiedEmail via router.use`)
  })
}

// Routers that MUST NOT blanket-gate: pre-verification/onboarding and machine
// auth paths. Auth handles its own selective gating; unsubscribe is public;
// ingest authenticates by API key (no user email to verify).
for (const file of ['auth.ts', 'unsubscribe.ts', 'ingest.ts']) {
  test(`verification gate: ${file} does not apply a router-level mutation gate`, () => {
    const src = read(file)
    assert.doesNotMatch(src, /\.use\(requireVerifiedForMutation\)/, `${file} must not blanket-gate mutations`)
  })
}

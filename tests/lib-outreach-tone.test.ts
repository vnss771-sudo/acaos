import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessOutreachTone,
  assertOutreachTone,
  OutreachToneError,
} from '../packages/backend-core/src/lib/outreachTone.ts'

test('assessOutreachTone: flags a presumptuous "I noticed you\'re struggling" opener as block', () => {
  const v = assessOutreachTone("Hi — I noticed you're struggling with dispatch across your crews.")
  assert.equal(v.length, 1)
  assert.equal(v[0].kind, 'presumptuous_claim')
  assert.equal(v[0].severity, 'block')
})

test('assessOutreachTone: flags "you\'re clearly overwhelmed" as block', () => {
  const v = assessOutreachTone("You're clearly overwhelmed with scheduling.")
  assert.ok(v.some((x) => x.kind === 'presumptuous_claim' && x.severity === 'block'))
})

test('assessOutreachTone: does NOT flag question-framed, general copy', () => {
  const ok =
    'A lot of growing plumbing teams reach a point where dispatch starts eating admin time. ' +
    'How are you handling scheduling as you add crews?'
  assert.deepEqual(assessOutreachTone(ok), [])
})

test('assessOutreachTone: flags banned buzzwords as warn-only', () => {
  const v = assessOutreachTone('We help you streamline operations and leverage synergy.')
  assert.ok(v.length >= 2)
  assert.ok(v.every((x) => x.kind === 'banned_phrase' && x.severity === 'warn'))
})

test('assertOutreachTone: throws OutreachToneError on a presumptuous claim', () => {
  assert.throws(
    () => assertOutreachTone({ subject: 'quick idea', email: "I can see your team is falling behind on jobs." }),
    (err: unknown) => err instanceof OutreachToneError && err.statusCode === 502,
  )
})

test('assertOutreachTone: returns buzzword warnings without throwing', () => {
  const warnings = assertOutreachTone({
    subject: 'scheduling',
    email: 'Wanted to share a way to streamline your day. Worth a look?',
  })
  assert.ok(warnings.length >= 1)
  assert.ok(warnings.every((w) => w.severity === 'warn'))
})

test('assertOutreachTone: scans the followup too', () => {
  assert.throws(
    () => assertOutreachTone({ subject: 's', email: 'all good', followup: "I know you're drowning in admin." }),
    (err: unknown) => err instanceof OutreachToneError,
  )
})

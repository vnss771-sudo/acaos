import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDomain, normalizeCompanyNameKey, normalizeEmailKey, isDeliverableEmail, normalizeEmail } from '../packages/backend-core/src/lib/normalize.ts'

describe('normalizeDomain', () => {
  it('lowercases and strips a leading www.', () => {
    assert.equal(normalizeDomain('WWW.Acme.com'), 'acme.com')
  })
  it('strips scheme, path, query and port', () => {
    assert.equal(normalizeDomain('https://www.acme.com:443/pricing?ref=x'), 'acme.com')
  })
  it('returns null for empty/nullish input', () => {
    assert.equal(normalizeDomain(''), null)
    assert.equal(normalizeDomain(null), null)
    assert.equal(normalizeDomain(undefined), null)
  })
  it('treats www-prefixed and bare domains as the same key', () => {
    assert.equal(normalizeDomain('www.acme.com'), normalizeDomain('acme.com'))
  })
})

describe('normalizeCompanyNameKey', () => {
  it('collapses case, punctuation and whitespace', () => {
    assert.equal(normalizeCompanyNameKey('  Acme   Widgets!! '), 'acme widgets')
  })
  it('drops a trailing legal-entity suffix', () => {
    assert.equal(normalizeCompanyNameKey('Acme, Inc.'), 'acme')
    assert.equal(normalizeCompanyNameKey('ACME LLC'), 'acme')
    assert.equal(normalizeCompanyNameKey('Acme Corporation'), 'acme')
  })
  it('treats suffix variants as the same key', () => {
    assert.equal(normalizeCompanyNameKey('Acme, Inc.'), normalizeCompanyNameKey('ACME LLC'))
  })
  it('keeps a single-token name even if it is a suffix word', () => {
    // Don't strip the only token — "Co" as a whole name stays "co".
    assert.equal(normalizeCompanyNameKey('Co'), 'co')
  })
  it('returns null when nothing meaningful remains', () => {
    assert.equal(normalizeCompanyNameKey('!!!'), null)
    assert.equal(normalizeCompanyNameKey(''), null)
    assert.equal(normalizeCompanyNameKey(null), null)
  })
})

describe('normalizeEmailKey', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeEmailKey('  Alex@Example.COM '), 'alex@example.com')
  })
  it('folds a plus-address tag', () => {
    assert.equal(normalizeEmailKey('alex+sales@example.com'), 'alex@example.com')
  })
  it('treats plus-tagged and bare addresses as the same key', () => {
    assert.equal(normalizeEmailKey('alex+a@x.com'), normalizeEmailKey('alex+b@x.com'))
  })
  it('rejects malformed addresses', () => {
    assert.equal(normalizeEmailKey('not-an-email'), null)
    assert.equal(normalizeEmailKey('a@b@c.com'), null)
    assert.equal(normalizeEmailKey('@x.com'), null)
    assert.equal(normalizeEmailKey('alex@'), null)
    assert.equal(normalizeEmailKey('+tag@x.com'), null)
  })
})

describe('isDeliverableEmail', () => {
  it('accepts well-formed addresses', () => {
    assert.equal(isDeliverableEmail('alex@example.com'), true)
    assert.equal(isDeliverableEmail('  Alex.Smith@sub.example.co.uk '), true)
  })
  it('rejects structurally invalid addresses', () => {
    assert.equal(isDeliverableEmail('not-an-email'), false)
    assert.equal(isDeliverableEmail('alex@nodot'), false)
    assert.equal(isDeliverableEmail('alex @example.com'), false)
    assert.equal(isDeliverableEmail('a@b@c.com'), false)
    assert.equal(isDeliverableEmail('@example.com'), false)
  })
  it('rejects control characters and empty/nullish input', () => {
    assert.equal(isDeliverableEmail('alex\n@example.com'), false)
    assert.equal(isDeliverableEmail(''), false)
    assert.equal(isDeliverableEmail(null), false)
    assert.equal(isDeliverableEmail(undefined), false)
  })
})

describe('normalizeEmail (suppression/contact key)', () => {
  it('trims and lowercases', () => {
    assert.equal(normalizeEmail('  Alex@Example.COM '), 'alex@example.com')
  })
  it('does NOT fold plus-addressing (distinct recipients)', () => {
    assert.notEqual(normalizeEmail('john+test@example.com'), normalizeEmail('john@example.com'))
    assert.equal(normalizeEmail('john+test@example.com'), 'john+test@example.com')
  })
  it('returns empty string for nullish input', () => {
    assert.equal(normalizeEmail(null), '')
    assert.equal(normalizeEmail(undefined), '')
  })
})

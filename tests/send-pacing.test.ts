// Unit tests for per-domain send-pacing helpers (pure). The end-to-end cap
// enforcement in sendCampaignBatch is covered in the DB tier.

import test from 'node:test'
import assert from 'node:assert/strict'
import { perDomainDailyCap, emailDomain, tallyDomains } from '../packages/backend-core/src/lib/sendPacing.ts'

test('perDomainDailyCap: disabled by default; a positive integer enables it', () => {
  const saved = process.env.PER_DOMAIN_DAILY_CAP
  try {
    delete process.env.PER_DOMAIN_DAILY_CAP
    assert.equal(perDomainDailyCap(), null, 'unset → disabled (unchanged behaviour)')
    process.env.PER_DOMAIN_DAILY_CAP = '200'
    assert.equal(perDomainDailyCap(), 200)
    process.env.PER_DOMAIN_DAILY_CAP = '0'
    assert.equal(perDomainDailyCap(), null, '0 → disabled')
    process.env.PER_DOMAIN_DAILY_CAP = '-5'
    assert.equal(perDomainDailyCap(), null, 'negative → disabled')
    process.env.PER_DOMAIN_DAILY_CAP = 'garbage'
    assert.equal(perDomainDailyCap(), null, 'garbage → disabled')
  } finally {
    if (saved === undefined) delete process.env.PER_DOMAIN_DAILY_CAP
    else process.env.PER_DOMAIN_DAILY_CAP = saved
  }
})

test('emailDomain: extracts the lowercased domain, or null', () => {
  assert.equal(emailDomain('Alice@Gmail.COM'), 'gmail.com')
  assert.equal(emailDomain('a@b@corp.test'), 'corp.test', 'splits on the last @')
  assert.equal(emailDomain('no-at-sign'), null)
  assert.equal(emailDomain(''), null)
  assert.equal(emailDomain(null), null)
})

test('tallyDomains: counts by domain, ignoring malformed addresses', () => {
  const m = tallyDomains(['a@gmail.com', 'b@gmail.com', 'c@outlook.com', 'bad', null])
  assert.equal(m.get('gmail.com'), 2)
  assert.equal(m.get('outlook.com'), 1)
  assert.equal(m.has('bad'), false)
})

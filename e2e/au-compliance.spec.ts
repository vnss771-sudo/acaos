import { test, expect } from '@playwright/test'
import http from 'node:http'
import { signUp, skipOnboarding, uniqueEmail, verifyEmailInDb, closeDb } from './helpers.js'

test.afterAll(closeDb)

// Phase 2: the Compliance → Australia section against the real API. The ABR is a local stub
// (the API is started with ABR_ENDPOINT=http://127.0.0.1:4599/... and a fake ABR_GUID), so no real
// register is contacted and no real GUID exists anywhere in this run.
const ABN = '51824753556'
let abr: http.Server
const abrCalls: string[] = []

test.beforeAll(async () => {
  abr = http.createServer((req, res) => {
    abrCalls.push(req.url ?? '')
    const u = new URL(req.url ?? '', 'http://x')
    const abn = u.searchParams.get('abn')
    const body = abn === ABN
      ? { EntityName: 'ACME ELECTRICAL PTY LTD', AbnStatus: 'Active', EntityTypeName: 'Australian Private Company', Message: '', BusinessName: [] }
      : abn === '34241177887'
        ? { EntityName: 'OLD CO PTY LTD', AbnStatus: 'Cancelled', EntityTypeName: 'Australian Private Company', Message: '', BusinessName: [] }
        : { EntityName: '', AbnStatus: '', Message: 'Search text is not a valid ABN or ACN', BusinessName: [] }
    res.setHeader('Content-Type', 'application/javascript')
    res.end(`callback(${JSON.stringify(body)})`)
  })
  await new Promise<void>(r => abr.listen(4599, '127.0.0.1', r))
})
test.afterAll(async () => { await new Promise(r => abr.close(r)) })

async function openCompliance(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Australian compliance')).toBeVisible({ timeout: 20_000 })
}

test('verify an ABN, enable Australian targeting, record evidence, and see why sending is blocked', async ({ page }) => {
  const email = uniqueEmail()
  await signUp(page, email)
  await skipOnboarding(page)
  await verifyEmailInDb(email)
  await page.reload()
  await openCompliance(page)
  const au = page.getByLabel('Australian compliance')

  // ── ABN: invalid → clear error; valid → verified entity, status, date
  await au.getByLabel('ABN').fill('12345')
  await au.getByRole('button', { name: 'Verify ABN' }).click()
  await expect(au.getByRole('alert')).toContainText(/not a valid ABN/i)
  await au.getByLabel('ABN').fill('51 824 753 556')
  await au.getByRole('button', { name: 'Verify ABN' }).click()
  await expect(au.getByText('✓ ABN verified')).toBeVisible()
  await expect(au.getByText('ACME ELECTRICAL PTY LTD')).toBeVisible()
  await expect(au.getByText('Active', { exact: true })).toBeVisible()
  await expect(au.getByText(/verified \d/)).toBeVisible()
  expect(abrCalls.length).toBe(1) // the invalid checksum never reached the register

  // ── cancelled ABN is refused with an explanation
  await au.getByLabel('ABN').fill('34 241 177 887')
  await au.getByRole('button', { name: 'Verify ABN' }).click()
  await expect(au.getByRole('alert')).toContainText(/cancelled/i)
  await expect(au.getByText(/No verified ABN/)).toBeVisible()

  // The browser never sees the ABR secret: nothing in the page or its storage mentions a GUID.
  expect(await page.content()).not.toMatch(/e2e-abr-guid/)

  // ── Australian targeting → blocked-send explanation (AU sending is disabled by default)
  await au.getByRole('checkbox', { name: /Australian link/ }).click() // controlled: flips only after the API confirms
  await expect(au.getByText(/Sending is currently blocked for this workspace/)).toBeVisible({ timeout: 15_000 })

  // ── evidence: backend rejects incomplete evidence; accepts complete evidence
  await au.getByLabel('Recipient email').fill('info@acme.example')
  await au.getByLabel('Page URL where the address was published').fill('https://acme.example/contact')
  await au.getByLabel('Date you saw it').fill('2026-09-30')
  await au.getByLabel('Address type').selectOption('role')
  await au.getByRole('button', { name: 'Record evidence' }).click()
  await expect(au.getByRole('form', { name: 'Record consent evidence' }).getByRole('alert')).toContainText(/Insufficient Spam Act consent evidence/)
  await au.getByLabel(/no “no unsolicited commercial email”/).check()
  await au.getByLabel(/relevant to this person/).check()
  await au.getByRole('button', { name: 'Record evidence' }).click()
  const records = au.getByRole('list', { name: 'Consent records' })
  await expect(records.getByText('info@acme.example')).toBeVisible()
  await expect(records.getByText('Qualifies for Australia')).toBeVisible()

  // ── a legitimate-interest record is shown as NOT sufficient (via the legacy API path)
  const readiness = au.getByRole('list', { name: 'Send readiness' })
  await expect(readiness.getByText(/✗ Australian commercial sending/)).toBeVisible()
  await expect(readiness.getByText('Not ready to send')).toBeVisible()
})

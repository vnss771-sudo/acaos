import { test, expect } from '@playwright/test'
import { signUp, skipOnboarding, uniqueEmail, apiLogin, getWorkspaceId, PASSWORD, closeDb } from './helpers.js'

test.afterAll(closeDb)

// Flow 3 — regression for the campaign-launch bug.
// confirmLaunch() POSTed an empty body to /api/campaigns/:id/send. With
// approvalMode enabled (the DEFAULT for onboarded workspaces) the backend 403s
// unless the body carries { approved: true }, so campaigns could never be sent.
// We set up the campaign + eligible leads via the API, then drive the real
// "Launch" → "Approve & Send" UI and assert the request now carries the flag and
// is accepted (202).
test('Launching an approval-mode campaign sends { approved: true } and is accepted', async ({ page, request }) => {
  const email = uniqueEmail()
  await signUp(page, email)
  await skipOnboarding(page)

  // Preconditions via API (tedious to do through the UI, not what's under test).
  const token = await apiLogin(request, email, PASSWORD)
  const auth = { Authorization: `Bearer ${token}` }
  const workspaceId = await getWorkspaceId(request, token)

  // Enable approval mode — this is what makes the backend require { approved:true }.
  const icpRes = await request.put(`/api/workspaces/${workspaceId}/icp`, {
    headers: auth,
    data: {
      businessType: 'Industrial Services',
      playbook: null,
      targetIndustries: [],
      targetGeos: [],
      minEmployees: null,
      maxEmployees: null,
      mustHaveEmail: false,
      outreachTone: 'professional',
      dailySendLimit: 50,
      approvalMode: true,
      excludedIndustries: [],
    },
  })
  expect(icpRes.ok(), `icp put failed: ${icpRes.status()} ${await icpRes.text()}`).toBeTruthy()

  const campRes = await request.post('/api/campaigns', {
    headers: auth,
    data: { workspaceId, name: 'E2E Launch Campaign', goalType: 'BOOK_CALL', description: 'e2e' },
  })
  expect(campRes.ok()).toBeTruthy()
  const campaignId = (await campRes.json()).campaign.id as string

  // Two eligible leads (have email, default NEW stage, linked to the campaign).
  const importRes = await request.post('/api/leads/import', {
    headers: auth,
    data: {
      workspaceId,
      leads: [
        { businessName: 'Eligible Lead One', email: 'one@example.com', campaignId },
        { businessName: 'Eligible Lead Two', email: 'two@example.com', campaignId },
      ],
    },
  })
  expect(importRes.ok()).toBeTruthy()

  // Drive the real UI.
  await page.getByRole('button', { name: /Campaigns/ }).click()
  await expect(page.getByText('E2E Launch Campaign')).toBeVisible()

  const launch = page.getByRole('button', { name: /Launch Campaign/ })
  await expect(launch).toBeEnabled() // enabled only once stats report eligible > 0
  await launch.click()

  const sendPromise = page.waitForResponse(
    (r) => /\/api\/campaigns\/.+\/send$/.test(r.url()) && r.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /Approve & Send/ }).click()
  const sendRes = await sendPromise

  // The frontend must send the approval flag the backend mandates.
  expect(sendRes.request().postDataJSON()).toMatchObject({ approved: true })
  // And the send must be accepted, not 403'd by the approval guard.
  expect(sendRes.status()).toBe(202)
  await expect(page.getByText(/Approved — sending to/)).toBeVisible()
})

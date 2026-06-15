import { test, expect } from '@playwright/test'
import { signUp, skipOnboarding, uniqueEmail, verifyEmailInDb, closeDb } from './helpers.js'

test.afterAll(closeDb)

// Flow 2 — regression for the AI Tools sync-mode bug.
// The default "Run" mode POSTed to /api/ai/research without workspaceId, which
// every AI handler rejects with 400 "workspaceId required" as its first check,
// so the page was dead on arrival. This drives the real button and asserts the
// outgoing request now carries workspaceId and is NOT rejected on that ground.
test('AI Tools "Run" sends workspaceId and clears the contract check', async ({ page }) => {
  const email = uniqueEmail()
  await signUp(page, email)
  await skipOnboarding(page)
  // AI routes require a verified email; flip it directly so we reach the handler.
  await verifyEmailInDb(email)

  await page.getByRole('button', { name: /AI Tools/ }).click()
  await page.getByPlaceholder('Acme Plumbing Brisbane').fill('Acme Plumbing Brisbane')

  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/ai/research') && r.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /Run Lead Research/ }).click()
  const response = await responsePromise

  // The frontend must include workspaceId in the request body.
  const sent = response.request().postDataJSON()
  expect(sent).toHaveProperty('workspaceId')
  expect(sent.workspaceId).toBeTruthy()

  // The server must not reject it on the contract. Without an OpenAI key it will
  // 503 ("OpenAI is not configured") — that's fine; it proves the request got
  // past auth + verification + the workspaceId guard into the AI layer.
  expect(response.status()).not.toBe(400)
  const body = await response.json().catch(() => ({}))
  expect(String(body.error ?? '')).not.toMatch(/workspaceId required/i)
})

import { test, expect } from '@playwright/test'
import { signUp, uniqueEmail, closeDb } from './helpers.js'

test.afterAll(closeDb)

// Flow 1: a brand-new user completes onboarding and lands on a non-empty radar.
// Exercises signup -> wizard -> playbook -> ICP -> example seeding -> the seeded
// prospects actually rendering in the UI. Pure DB, no external services.
test('signup → onboarding seeds example prospects that appear in the UI', async ({ page }) => {
  await signUp(page, uniqueEmail())

  // Step 1: pick the first playbook (Industrial Services). Its "→ Select" is the
  // first one in the grid, and the backend seeds Industrial example companies.
  await page.getByRole('button', { name: /Select/ }).first().click()

  // Step 2: ICP form — accept defaults.
  await page.getByRole('button', { name: /Continue/ }).click()

  // Step 3: keep "include examples" on.
  await page.getByRole('button', { name: /Looks good/ }).click()

  // Step 4: enter the app.
  await page.getByRole('button', { name: /Open Acquisition Radar/ }).click()

  // The seeded Industrial example company must be visible in the Prospects view.
  await page.getByRole('button', { name: /Prospects/ }).click()
  await expect(page.getByText('Summit Plant & Equipment')).toBeVisible()
})

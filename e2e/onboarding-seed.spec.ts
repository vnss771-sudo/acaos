import { test, expect } from '@playwright/test'
import { signUp, uniqueEmail, closeDb } from './helpers.js'

test.afterAll(closeDb)

// Flow 1: a brand-new user completes onboarding and lands on a non-empty radar.
// Exercises signup -> wizard -> playbook -> ICP -> example seeding -> the seeded
// prospects actually rendering in the UI. Pure DB, no external services.
test('signup → onboarding seeds example prospects that appear in the UI', async ({ page }) => {
  await signUp(page, uniqueEmail())

  // The first screen asks which path; this spec covers the email-outreach one.
  await page.getByRole('button', { name: /Set up email outreach/ }).click()

  // Step 1: pick the first playbook (Industrial Services). Its "Select" is the
  // first one in the grid, and the backend seeds Industrial example companies.
  await page.getByRole('button', { name: /Select Industrial Services/ }).click()

  // Step 2: targeting form — accept defaults.
  await page.getByRole('button', { name: /Continue/ }).click()

  // Step 3: add the example companies.
  await page.getByRole('button', { name: /Looks good/ }).click()

  // First-prospects step: this spec covers example seeding, so skip it.
  await page.getByRole('button', { name: /Skip for now/ }).click()

  // Step 4: enter the app without connecting email yet.
  await page.getByRole('button', { name: /Explore first/ }).click()

  // The seeded Industrial example company must be visible on the Clients page (Work hub).
  await page.getByRole('button', { name: /^Work$/ }).click()
  await page.getByRole('tab', { name: 'Clients' }).click()
  await expect(page.getByText('Summit Plant & Equipment')).toBeVisible()
})

// Flow 1b: a trade contractor's onboarding — trades and area become the Find work
// profile, and setup lands on Find work, not an empty dashboard.
test('signup → contractor onboarding sets up Find work and lands on it', async ({ page }) => {
  await signUp(page, uniqueEmail())
  await page.getByRole('button', { name: /I'm a trade contractor/ }).click()
  await page.getByLabel('Electrical').check()
  await page.getByLabel('QLD').check()
  await page.getByRole('button', { name: /Start finding work/ }).click()
  await page.getByRole('button', { name: /Go to Find work/ }).click()
  await expect(page.getByRole('heading', { name: 'Find work' })).toBeVisible()
  await expect(page).toHaveURL(/\/ops\/find-work$/)
  // The profile was saved: the setup prompt is gone.
  await expect(page.getByText('Tell us what work you want')).toBeHidden()
})

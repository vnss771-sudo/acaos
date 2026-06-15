import { type Page, type APIRequestContext, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

export const PASSWORD = 'Sup3rStrongPass!'

let prisma: PrismaClient | null = null
function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient()
  return prisma
}

/** Unique, lowercase email so parallel/repeat runs never collide on the unique index. */
export function uniqueEmail(): string {
  return `e2e+${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`
}

/**
 * Sign up through the real AuthScreen UI. Leaves the app authenticated with the
 * onboarding wizard open (new workspaces have onboardingCompleted=false).
 */
export async function signUp(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/')
  // Switch the mode toggle from "Sign in" to "Create account" (first match = toggle).
  await page.getByRole('button', { name: 'Create account' }).first().click()
  await page.getByPlaceholder('Your name').fill('E2E Tester')
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByPlaceholder('At least 8 characters').fill(password)
  // Submit (last match = the form's submit button, not the mode toggle).
  await page.getByRole('button', { name: 'Create account' }).last().click()
  // Onboarding wizard is the first authenticated screen for a fresh account.
  await expect(page.getByText('Welcome to ACAOS', { exact: false })).toBeVisible()
}

/** Dismiss the onboarding wizard (sets onboardingCompleted, creates no ICP/examples). */
export async function skipOnboarding(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Skip setup/ }).click()
  await expect(page.getByText('Welcome to ACAOS', { exact: false })).toBeHidden()
}

/** Mark a user's email verified directly in the DB (the AI routes gate on it). */
export async function verifyEmailInDb(email: string): Promise<void> {
  await db().user.update({
    where: { email: email.toLowerCase() },
    data: { emailVerified: true },
  })
}

/** Programmatic login for fast precondition setup (independent of the browser session). */
export async function apiLogin(request: APIRequestContext, email: string, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { email, password } })
  expect(res.ok(), `login failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  return (await res.json()).token as string
}

export async function getWorkspaceId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  expect(res.ok()).toBeTruthy()
  const data = await res.json()
  return data.workspaces[0].id as string
}

export async function closeDb(): Promise<void> {
  if (prisma) { await prisma.$disconnect(); prisma = null }
}

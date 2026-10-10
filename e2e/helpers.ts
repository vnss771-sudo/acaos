import { type Page, type APIRequestContext, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

export const PASSWORD = 'Sup3rStrongPass!'

let prisma: PrismaClient | null = null
function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient()
  return prisma
}

/** Unique, lowercase email so parallel/repeat runs never collide on the unique index. */
export function uniqueEmail(): string {
  return `e2e+${Date.now()}_${randomUUID().slice(0, 8)}@example.com`
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
  await page.getByPlaceholder('At least 12 characters').fill(password)
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

export async function createApiAccount(request: APIRequestContext): Promise<{ email: string; token: string; workspaceId: string; userId: string }> {
  const email = uniqueEmail()
  const res = await request.post('/api/auth/signup', { data: { email, password: PASSWORD, name: 'E2E API Tester' } })
  expect(res.ok(), `signup failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const body = await res.json() as { token: string; workspace: { id: string } }
  await verifyEmailInDb(email)
  const user = await db().user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } })
  if (!user) throw new Error('E2E signup user missing after verification')
  return { email, token: body.token, workspaceId: body.workspace.id, userId: user.id }
}

export async function seedRepliedThread(workspaceId: string, toEmail = 'prospect@example.com'): Promise<string> {
  const row = await db().outreachSent.create({
    data: { workspaceId, toEmail, subject: 'Original subject', body: 'Original body', status: 'REPLIED', repliedAt: new Date() },
    select: { id: true },
  })
  return row.id
}

export async function suppressWorkspace(workspaceId: string): Promise<void> {
  await db().workspace.update({ where: { id: workspaceId }, data: { sendSuppressed: true, sendSuppressedReason: 'e2e safety stop' } })
}

export async function suppressRecipient(workspaceId: string, email: string): Promise<void> {
  const emailKey = email.trim().toLowerCase()
  await db().suppression.upsert({
    where: { workspaceId_emailKey: { workspaceId, emailKey } },
    update: { reason: 'UNSUBSCRIBED' },
    create: { workspaceId, email, emailKey, reason: 'UNSUBSCRIBED' },
  })
}

export async function degradeSenderReputation(workspaceId: string, email = 'prospect@example.com'): Promise<void> {
  await db().contactEvent.createMany({
    data: [
      { workspaceId, emailKey: email.toLowerCase(), type: 'SENT', occurredAt: new Date() },
      { workspaceId, emailKey: email.toLowerCase(), type: 'BOUNCED', occurredAt: new Date() },
    ],
  })
}

export async function seedUnsafeMailboxConfig(workspaceId: string): Promise<void> {
  await db().workspaceEmailConfig.upsert({
    where: { workspaceId },
    update: { smtpHost: '127.0.0.1', smtpPort: 25, smtpSecure: false, smtpFrom: 'sender@example.com' },
    create: { workspaceId, smtpHost: '127.0.0.1', smtpPort: 25, smtpSecure: false, smtpFrom: 'sender@example.com' },
  })
}

export async function closeDb(): Promise<void> {
  if (prisma) { await prisma.$disconnect(); prisma = null }
}

/**
 * Seed an APPROVED outreach draft for a lead (by email) — mirrors the real
 * Review Queue approval so an approval-mode campaign has something to send.
 */
export async function approveDraftForLead(workspaceId: string, leadEmail: string): Promise<void> {
  const lead = await db().lead.findFirst({ where: { workspaceId, email: leadEmail } })
  if (!lead) throw new Error(`approveDraftForLead: no lead found for ${leadEmail}`)
  await db().outreachDraft.create({
    data: {
      leadId: lead.id,
      workspaceId,
      subject: 'Approved subject',
      emailBody: 'Approved body',
      status: 'APPROVED',
      reviewedAt: new Date(),
    },
  })
}


/** Seed a minimal public-work opportunity that can be quoted through the real delivery API. */
export async function seedDeliveryOpportunity(workspaceId: string): Promise<string> {
  const row = await db().opportunity.create({
    data: {
      workspaceId,
      source: 'e2e',
      externalId: `e2e_${Date.now()}_${randomUUID().slice(0, 8)}`,
      kind: 'CONTRACT_AWARD',
      title: 'E2E Warehouse Electrical Package',
      description: 'Delivery-loop E2E fixture',
      region: 'QLD',
      score: 91,
      matchedTrades: ['electrical'],
      reasons: ['E2E deterministic fixture'],
      recommendedAction: 'Review and quote',
      contentHash: `e2e_${Date.now()}_${randomUUID().slice(0, 8)}`,
    },
    select: { id: true },
  })
  return row.id
}

export async function seedCrewMember(workspaceId: string, baseRate = 50): Promise<string> {
  const row = await db().opsCrewMember.create({
    data: {
      workspaceId,
      employeeCode: `E2E-${Date.now()}-${randomUUID().slice(0, 6)}`,
      fullName: 'E2E Crew Member',
      role: 'Electrician',
      baseRate,
    },
    select: { id: true },
  })
  return row.id
}

export async function seedShift(input: {
  workspaceId: string
  crewMemberId: string
  jobSiteId: string
  open?: boolean
  totalHours?: number
}): Promise<string> {
  const now = new Date()
  const hours = input.totalHours ?? 8
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000)
  // Costed to the site's job, as clock-in would attribute it (UQ-24).
  const job = await db().job.findFirst({ where: { workspaceId: input.workspaceId, opsJobSiteId: input.jobSiteId }, select: { id: true } })
  const row = await db().opsShiftRecord.create({
    data: {
      workspaceId: input.workspaceId,
      crewMemberId: input.crewMemberId,
      jobSiteId: input.jobSiteId,
      jobId: job?.id ?? null,
      shiftDate: start,
      startTime: start,
      endTime: input.open ? null : now,
      totalHours: input.open ? 0 : hours,
    },
    select: { id: true },
  })
  return row.id
}

export async function closeShift(shiftId: string, totalHours = 8): Promise<void> {
  await db().opsShiftRecord.update({ where: { id: shiftId }, data: { endTime: new Date(), totalHours } })
}

export async function readJob(jobId: string) {
  return db().job.findUnique({ where: { id: jobId } })
}

export async function seedStaleAndFreshSends(workspaceId: string): Promise<{ staleId: string; freshId: string }> {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const fresh = new Date()
  const [stale, recent] = await Promise.all([
    db().outreachSent.create({
      data: { workspaceId, toEmail: 'stale@example.com', subject: 'stale', body: 'stale', status: 'SENDING', claimedAt: old },
      select: { id: true },
    }),
    db().outreachSent.create({
      data: { workspaceId, toEmail: 'fresh@example.com', subject: 'fresh', body: 'fresh', status: 'SENDING', claimedAt: fresh },
      select: { id: true },
    }),
  ])
  return { staleId: stale.id, freshId: recent.id }
}

export async function readOutreachSend(id: string) {
  return db().outreachSent.findUnique({ where: { id } })
}

// Single source of truth for "can this workspace send outreach yet?". Used both
// to gate the campaign launch (server-side enforcement) and to power the
// onboarding send-readiness panel (so an operator sees exactly what's missing
// before they ever hit a 422).
import { prisma } from './prisma.js'
import { isMailConfigured } from '../services/mail.js'

export type ReadinessCheck = { name: string; label: string; ok: boolean; hint: string }
export type SendReadiness = { ready: boolean; checks: ReadinessCheck[] }

export async function getSendReadiness(workspaceId: string): Promise<SendReadiness> {
  const [emailCfg, ws] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { senderBusinessName: true, senderPostalAddress: true },
    }),
  ])

  const checks: ReadinessCheck[] = [
    {
      name: 'smtpConfigured',
      label: 'Email sending configured',
      ok: isMailConfigured(emailCfg ?? undefined),
      hint: 'Add your SMTP host and from-address in Settings → Email.',
    },
    {
      name: 'senderBusinessName',
      label: 'Business name set',
      ok: Boolean(ws?.senderBusinessName?.trim()),
      hint: 'Required in the email footer for anti-spam compliance (CAN-SPAM).',
    },
    {
      name: 'senderPostalAddress',
      label: 'Postal / contact address set',
      ok: Boolean(ws?.senderPostalAddress?.trim()),
      hint: 'A physical mailing address is legally required in commercial email.',
    },
  ]

  return { ready: checks.every((c) => c.ok), checks }
}

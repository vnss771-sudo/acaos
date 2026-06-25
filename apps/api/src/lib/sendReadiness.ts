// Single source of truth for "can this workspace send outreach yet?". Used both
// to gate the campaign launch (server-side enforcement) and to power the
// onboarding send-readiness panel (so an operator sees exactly what's missing
// before they ever hit a 422).
import { prisma } from './prisma.js'
import { isMailConfigured } from '../services/mail.js'
import { isComplianceGateEnabled } from '@acaos/backend-core/lib/launchControls.js'

export type ReadinessCheck = { name: string; label: string; ok: boolean; hint: string }
export type SendReadiness = { ready: boolean; checks: ReadinessCheck[] }

export async function getSendReadiness(workspaceId: string): Promise<SendReadiness> {
  const [emailCfg, ws] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        senderBusinessName: true, senderPostalAddress: true,
        lawfulBasis: true, termsAcceptedAt: true, targetsCanada: true,
      },
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

  // Compliance gate — DORMANT by default. Only when COMPLIANCE_GATE_ENABLED is set
  // do these become part of `ready`, so the schema/API/UI ship without changing
  // send behaviour until the legal copy is signed off.
  if (isComplianceGateEnabled()) {
    checks.push(
      {
        name: 'lawfulBasis',
        label: 'Lawful basis recorded',
        ok: Boolean(ws?.lawfulBasis),
        hint: 'Confirm your GDPR lawful basis (usually legitimate interest) in Settings → Compliance.',
      },
      {
        name: 'termsAccepted',
        label: 'Outreach terms accepted',
        ok: Boolean(ws?.termsAcceptedAt),
        hint: 'Accept the acceptable-use & data-processing terms in Settings → Compliance.',
      },
    )
    if (ws?.targetsCanada) {
      const consentCount = await prisma.consentRecord.count({ where: { workspaceId } })
      checks.push({
        name: 'caslConsent',
        label: 'CASL consent basis (Canada)',
        ok: consentCount > 0,
        hint: 'CASL requires express/implied consent — record a consent basis before sending to Canadian recipients.',
      })
    }
  }

  return { ready: checks.every((c) => c.ok), checks }
}

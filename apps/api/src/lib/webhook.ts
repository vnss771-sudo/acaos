import { prisma } from './prisma.js'

export type WebhookEvent =
  | 'lead.created'
  | 'lead.stage_changed'
  | 'lead.scored'
  | 'lead.reply_received'
  | 'lead.booked'
  | 'lead.closed'

export async function fireWebhook(
  workspaceId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { webhookUrl: true }
  })
  if (!workspace?.webhookUrl) return

  const body = JSON.stringify({
    event,
    workspaceId,
    timestamp: new Date().toISOString(),
    data: payload
  })

  // Fire-and-forget — don't await, don't crash the caller
  fetch(workspace.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ACAOS-Webhook/1.0'
    },
    body,
    signal: AbortSignal.timeout(8000)
  }).catch(() => {
    // Webhook delivery is best-effort
  })
}

// Stage-specific helper — fires only when stage is noteworthy
export function fireStageWebhook(
  workspaceId: string,
  leadId: string,
  businessName: string,
  fromStage: string,
  toStage: string
): void {
  const eventMap: Record<string, WebhookEvent> = {
    REPLIED: 'lead.reply_received',
    BOOKED: 'lead.booked',
    CLOSED: 'lead.closed'
  }
  const event = eventMap[toStage] ?? 'lead.stage_changed'
  fireWebhook(workspaceId, event, {
    leadId,
    businessName,
    fromStage,
    toStage
  })
}

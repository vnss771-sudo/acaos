import React, { useEffect, useState } from 'react'
import { colors } from '../../styles.js'
import { Modal } from '../ui/Modal.js'
import { Spinner } from '../Spinner.js'
import type { ApiHook } from '../../hooks/useApi.js'

// Shape of GET /api/admin/workspaces/:id/diagnostics (UQ-31). Read-only; no
// message content, recipients or credentials are ever part of it.
type Counts = Record<string, number>
export type WorkspaceDiagnostics = {
  workspace: { id: string; name: string; createdAt: string; onboardingCompleted: boolean }
  sending: {
    suppressed: boolean; suppressedReason: string | null; last24h: Counts; staleSending: number; staleAfterMinutes: number
    reputation: { healthy: boolean; sends: number; bounceRate: number; complaintRate: number; reason: string | null }
    autonomy: { ready: boolean; optedIn: boolean; blockers: string[] }
  }
  billing: { plan: string; providerStatus: string | null; hasSubscription: boolean; entitlement: string; effectivePlan: string; graceUntil: string | null }
  mailbox: null | {
    smtpConfigured: boolean; imapConfigured: boolean; authMethod: string; oauthConnected: boolean; oauthActionRequired: boolean
    replySyncStarted: boolean; domainHealth: string | null; domainHealthCheckedAt: string | null
  }
  followups: Counts
  discovery: { runsLast7d: Counts; sources: Array<{ source: string; runs: number; failures: number; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; lastWarning: string | null }> }
  recentFailures: Array<{ type: string; entityType: string | null; entityId: string | null; at: string }>
  generatedAt: string
}
type Release = { version: string; commit: string | null; releaseId?: string | null; environment?: string }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
const counts = (c: Counts) => (Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ') : 'none')

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.textFaint, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: colors.text, display: 'grid', gap: 2 }}>{children}</div>
    </div>
  )
}
const Warn = ({ on, children }: { on: boolean; children: React.ReactNode }) => <div style={{ color: on ? colors.amber : colors.text }}>{children}</div>

export function WorkspaceDiagnosticsModal({ api, workspaceId, onClose }: { api: ApiHook; workspaceId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ diagnostics: WorkspaceDiagnostics; release: Release } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    setData(null); setError(null)
    api<{ diagnostics: WorkspaceDiagnostics; release: Release }>(`/api/admin/workspaces/${workspaceId}/diagnostics`)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load diagnostics'))
  }, [api, workspaceId])

  const d = data?.diagnostics
  return (
    <Modal open={workspaceId != null} onClose={onClose} title={d ? `Diagnostics — ${d.workspace.name}` : 'Diagnostics'} width={640}>
      {error && <div role="alert" style={{ color: colors.red, fontSize: 13 }}>{error}</div>}
      {!d && !error && <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>}
      {d && (
        <div>
          <div style={{ fontSize: 12, color: colors.textFaint }}>Read-only · generated {when(d.generatedAt)} · onboarding {d.workspace.onboardingCompleted ? 'complete' : 'incomplete'}</div>
          <Section title="Sending">
            <Warn on={d.sending.suppressed}>{d.sending.suppressed ? `Suppressed: ${d.sending.suppressedReason ?? 'no reason recorded'}` : 'Not suppressed'}</Warn>
            <div>Last 24h: {counts(d.sending.last24h)}</div>
            <Warn on={d.sending.staleSending > 0}>Stuck in SENDING over {d.sending.staleAfterMinutes} min: {d.sending.staleSending} (outcome uncertain — not safe to retry blindly)</Warn>
            <Warn on={!d.sending.reputation.healthy}>Reputation: {d.sending.reputation.healthy ? 'healthy' : d.sending.reputation.reason} · {d.sending.reputation.sends} sends · bounce {pct(d.sending.reputation.bounceRate)} · complaint {pct(d.sending.reputation.complaintRate)}</Warn>
            <div>Automatic sending: {d.sending.autonomy.ready ? 'ready' : 'human approval'}{d.sending.autonomy.blockers.length ? ` (${d.sending.autonomy.blockers.join(', ')})` : ''}</div>
          </Section>
          <Section title="Billing">
            <Warn on={d.billing.entitlement === 'lapsed' || d.billing.entitlement === 'grace'}>
              Plan {d.billing.plan} → effective {d.billing.effectivePlan} ({d.billing.entitlement}) · Stripe {d.billing.providerStatus ?? 'none'}{d.billing.graceUntil ? ` · grace until ${when(d.billing.graceUntil)}` : ''}
            </Warn>
          </Section>
          <Section title="Mailbox">
            {d.mailbox ? (
              <>
                <div>SMTP {d.mailbox.smtpConfigured ? 'configured' : 'missing'} · IMAP {d.mailbox.imapConfigured ? 'configured' : 'missing'} · {d.mailbox.authMethod.toLowerCase()}</div>
                <Warn on={d.mailbox.oauthActionRequired}>{d.mailbox.oauthActionRequired ? 'OAuth needs reconnecting' : d.mailbox.oauthConnected ? 'OAuth connected' : 'No OAuth'}</Warn>
                <div>Reply sync {d.mailbox.replySyncStarted ? 'running' : 'not started'} · domain health {d.mailbox.domainHealth ?? 'unchecked'} ({when(d.mailbox.domainHealthCheckedAt)})</div>
              </>
            ) : <Warn on>No mailbox configured</Warn>}
          </Section>
          <Section title="Follow-ups"><div>{counts(d.followups)}</div></Section>
          <Section title="Discovery">
            <div>Runs (7 days): {counts(d.discovery.runsLast7d)}</div>
            {d.discovery.sources.map(src => (
              <Warn key={src.source} on={!!src.lastError}>
                {src.source}: {src.runs} runs, {src.failures} failed · last success {when(src.lastSuccessAt)}{src.lastError ? ` · ${src.lastError}` : ''}
              </Warn>
            ))}
          </Section>
          <Section title="Recent failures (7 days)">
            {d.recentFailures.length ? d.recentFailures.map((f, i) => (
              <div key={i} style={{ fontSize: 12 }}>{when(f.at)} · {f.type}{f.entityType ? ` · ${f.entityType} ${f.entityId ?? ''}` : ''}</div>
            )) : <div>None</div>}
          </Section>
          {data?.release && (
            <Section title="API release">
              <div style={{ fontSize: 12 }}>{data.release.version}{data.release.commit ? ` · ${data.release.commit.slice(0, 12)}` : ''}{data.release.releaseId ? ` · ${data.release.releaseId}` : ''}</div>
            </Section>
          )}
        </div>
      )}
    </Modal>
  )
}

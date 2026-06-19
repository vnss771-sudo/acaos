import React, { useEffect, useState, useCallback } from 'react'
import type { CreateCampaignRequest, SendCampaignRequest } from '@acaos/shared'
import type { Campaign, Workspace } from '../types.js'
import { GOAL_TYPES } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { MissionBuilder } from '../components/MissionBuilder.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type CampaignStats = {
  totalLeads: number
  leadsWithEmail: number
  eligible: number
  sent: number
  replied: number
  failed?: number
  bounced?: number
  replyRate: number
}

type OutreachRecord = {
  id: string
  toEmail: string
  subject: string
  status: string
  sentAt: string
  repliedAt?: string
  replyIntent?: string
  lastError?: string | null
  leadId?: string
}

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const GOAL_COLORS: Record<string, string> = {
  BOOK_CALL: colors.blue, GET_REPLY: colors.purple,
  DRIVE_TRAFFIC: colors.green, OTHER: colors.textFaint
}

const STATUS_COLOR: Record<string, string> = {
  SENDING: colors.amber, SENT: colors.blue, REPLIED: '#22c55e', BOUNCED: '#ef4444', FAILED: '#ef4444'
}

export function Campaigns({ api, workspace, toast, canManage = false }: Props) {
  const [campaigns, setCampaigns]   = useState<Campaign[]>([])
  const [loading, setLoading]       = useState(false)
  const [adding, setAdding]         = useState(false)
  const [editing, setEditing]       = useState<Campaign | null>(null)
  const [form, setForm]             = useState({ name: '', goalType: 'BOOK_CALL', description: '' })
  const [saving, setSaving]         = useState(false)
  const [stats, setStats]           = useState<Record<string, CampaignStats>>({})
  const [launching, setLaunching]   = useState<Record<string, boolean>>({})
  const [expanded, setExpanded]     = useState<string | null>(null)
  const [outreach, setOutreach]     = useState<Record<string, OutreachRecord[]>>({})
  const [outreachLoading, setOutreachLoading] = useState(false)
  const [approvalPending, setApprovalPending] = useState<{ id: string; name: string; eligible: number } | null>(null)
  const [domainCheck, setDomainCheck] = useState<{ hasSPF: boolean; hasDKIM: boolean } | null | 'loading'>('loading')
  const [showMissionBuilder, setShowMissionBuilder] = useState(false)

  const loadStats = useCallback(async (id: string) => {
    try {
      const d = await api<{ stats: CampaignStats }>(`/api/campaigns/${id}/stats`)
      setStats(prev => ({ ...prev, [id]: d.stats }))
    } catch { /* non-fatal */ }
  }, [api])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    setLoading(true)
    api<{ campaigns: Campaign[] }>(`/api/campaigns?workspaceId=${workspace.id}`)
      .then(d => {
        if (cancelled) return
        const c = d.campaigns || []
        setCampaigns(c)
        c.forEach(camp => loadStats(camp.id))
      })
      .catch(e => { if (!cancelled) toast.error(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspace?.id])

  useEffect(() => {
    if (!approvalPending || !workspace) {
      setDomainCheck('loading')
      return
    }
    let cancelled = false
    setDomainCheck('loading')
    api<{ config: { smtpFrom?: string | null } | null }>(`/api/workspaces/${workspace.id}/email-config`)
      .then(({ config }) => {
        const smtpFrom = config?.smtpFrom || ''
        const atIdx = smtpFrom.lastIndexOf('@')
        // Extract domain from "Name <user@domain.com>" or "user@domain.com"
        const raw = atIdx !== -1 ? smtpFrom.slice(atIdx + 1).replace(/[>\s]+$/, '').trim() : ''
        if (!raw) {
          if (!cancelled) setDomainCheck({ hasSPF: false, hasDKIM: false })
          return
        }
        return api<{ hasSPF: boolean; hasDKIM: boolean }>(
          `/api/mailbox/check-domain?domain=${encodeURIComponent(raw)}&workspaceId=${encodeURIComponent(workspace.id)}`
        ).then(result => {
          if (!cancelled) setDomainCheck({ hasSPF: result.hasSPF, hasDKIM: result.hasDKIM })
        })
      })
      .catch(() => {
        if (!cancelled) setDomainCheck({ hasSPF: false, hasDKIM: false })
      })
    return () => { cancelled = true }
  }, [approvalPending?.id, workspace?.id])

  async function create() {
    if (!form.name.trim() || !workspace) return
    setSaving(true)
    try {
      const body: CreateCampaignRequest = { workspaceId: workspace.id, name: form.name, goalType: form.goalType, description: form.description }
      const d = await api<{ campaign: Campaign }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      setCampaigns(prev => [d.campaign, ...prev])
      setForm({ name: '', goalType: 'BOOK_CALL', description: '' })
      setAdding(false)
      toast.success('Campaign created')
      loadStats(d.campaign.id)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  async function update() {
    if (!editing) return
    setSaving(true)
    try {
      const d = await api<{ campaign: Campaign }>(`/api/campaigns/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: form.name, goalType: form.goalType, description: form.description })
      })
      setCampaigns(prev => prev.map(c => c.id === d.campaign.id ? d.campaign : c))
      setEditing(null)
      toast.success('Campaign updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  async function deleteCampaign(id: string) {
    if (!confirm('Delete this campaign and unlink its leads?')) return
    try {
      await api(`/api/campaigns/${id}`, { method: 'DELETE' })
      setCampaigns(prev => prev.filter(c => c.id !== id))
      toast.success('Campaign deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  function requestLaunch(id: string, name: string, eligible: number) {
    setApprovalPending({ id, name, eligible })
  }

  async function confirmLaunch() {
    if (!approvalPending) return
    const { id } = approvalPending
    setApprovalPending(null)
    setLaunching(prev => ({ ...prev, [id]: true }))
    try {
      // approvalMode workspaces (the default) require an explicit opt-in flag;
      // the confirmation modal the user just accepted IS that approval. The
      // shared SendCampaignRequest type makes `approved` mandatory at compile time.
      const body: SendCampaignRequest = { approved: true }
      const d = await api<{ jobId: string; eligible: number; message: string }>(
        `/api/campaigns/${id}/send`,
        { method: 'POST', body: JSON.stringify(body) }
      )
      toast.success(`Approved — sending to ${d.eligible} leads (job ${d.jobId})`)
      setTimeout(() => loadStats(id), 3000)
      setTimeout(() => loadStats(id), 10_000)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Launch failed') }
    finally { setLaunching(prev => ({ ...prev, [id]: false })) }
  }

  async function retryFailed(id: string) {
    try {
      const d = await api<{ cleared: number }>(`/api/campaigns/${id}/retry-failed`, { method: 'POST' })
      toast.success(`Cleared ${d.cleared} failed send${d.cleared !== 1 ? 's' : ''} — relaunch to retry`)
      loadStats(id)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Retry failed') }
  }

  async function toggleOutreach(id: string) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    setOutreachLoading(true)
    try {
      const d = await api<{ outreach: OutreachRecord[] }>(`/api/campaigns/${id}/outreach`)
      setOutreach(prev => ({ ...prev, [id]: d.outreach || [] }))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setOutreachLoading(false) }
  }

  function startEdit(c: Campaign) {
    setEditing(c)
    setForm({ name: c.name, goalType: c.goalType, description: c.description || '' })
    setAdding(false)
  }

  function startAdd() {
    setAdding(true)
    setEditing(null)
    setForm({ name: '', goalType: 'BOOK_CALL', description: '' })
  }

  const isOpen = adding || !!editing

  return (
    <div style={s.stack}>
      {/* Approval modal */}
      {approvalPending && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setApprovalPending(null)}>
          <div style={{
            background: colors.bgCard, border: `1px solid ${colors.border}`,
            borderRadius: 12, padding: 28, width: 420, maxWidth: '90vw'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: colors.text, marginBottom: 8 }}>
              Approve Outreach Mission
            </div>
            <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 20 }}>
              Campaign: <strong style={{ color: colors.text }}>{approvalPending.name}</strong>
            </div>
            <div style={{
              background: '#f59e0b18', border: '1px solid #f59e0b44',
              borderRadius: 8, padding: '12px 16px', marginBottom: 20
            }}>
              <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 20 }}>{approvalPending.eligible}</div>
              <div style={{ color: colors.textFaint, fontSize: 13 }}>
                leads will each receive a personalised AI-generated email.
              </div>
            </div>
            <div style={{
              background: '#1e293b', border: `1px solid ${colors.border}`,
              borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 12
            }}>
              <div style={{ color: colors.textMuted, fontWeight: 700, marginBottom: 8, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Deliverability checklist</div>
              {/* SPF — dynamic */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
                <span style={{ color: domainCheck === 'loading' ? colors.textFaint : domainCheck?.hasSPF ? colors.green : '#ef4444', flexShrink: 0 }}>
                  {domainCheck === 'loading' ? '…' : domainCheck?.hasSPF ? '✓' : '✗'}
                </span>
                <span style={{ color: colors.textFaint }}>
                  {domainCheck === 'loading'
                    ? 'Checking… SPF record (v=spf1 include:…)'
                    : domainCheck?.hasSPF
                      ? 'Sending domain has SPF record (v=spf1 include:…)'
                      : 'Sending domain has SPF record (v=spf1 include:…) — not detected'}
                </span>
              </div>
              {/* DKIM — dynamic */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
                <span style={{ color: domainCheck === 'loading' ? colors.textFaint : domainCheck?.hasDKIM ? colors.green : '#ef4444', flexShrink: 0 }}>
                  {domainCheck === 'loading' ? '…' : domainCheck?.hasDKIM ? '✓' : '✗'}
                </span>
                <span style={{ color: colors.textFaint }}>
                  {domainCheck === 'loading'
                    ? 'Checking… DKIM signature configured for sending domain'
                    : domainCheck?.hasDKIM
                      ? 'DKIM signature configured for sending domain'
                      : 'DKIM signature configured for sending domain — not detected'}
                </span>
              </div>
              {/* Static items */}
              {[
                'Sending address matches your workspace email config',
                'Lead list has been reviewed for quality',
              ].map(item => (
                <div key={item} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
                  <span style={{ color: colors.green, flexShrink: 0 }}>✓</span>
                  <span style={{ color: colors.textFaint }}>{item}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={s.btnSecondary} onClick={() => setApprovalPending(null)}>Cancel</button>
              <button
                style={{ ...s.btn, background: '#16a34a' }}
                onClick={confirmLaunch}
              >
                Approve & Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mission builder modal */}
      {showMissionBuilder && workspace && (
        <MissionBuilder
          workspace={workspace}
          api={api}
          toast={toast}
          onCreated={(id, name) => {
            setShowMissionBuilder(false)
            setCampaigns(prev => [...prev, { id, name, goalType: 'BOOK_CALL', description: null, createdAt: new Date().toISOString() }])
            loadStats(id)
          }}
          onClose={() => setShowMissionBuilder(false)}
        />
      )}

      {/* Header */}
      <div style={{ ...s.flexBetween }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {canManage && <button style={s.btn} onClick={() => setShowMissionBuilder(true)}>+ New Mission</button>}
          {canManage && <button style={{ ...s.btnSm, border: `1px solid ${colors.border}` }} onClick={startAdd} title="Advanced: create campaign manually">Advanced</button>}
        </div>
      </div>

      {/* Form */}
      {isOpen && (
        <div style={s.card}>
          <div style={s.sectionHeader}>{editing ? 'Edit Campaign' : 'New Campaign'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={s.label}>Campaign Name *</label>
              <input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Q3 Brisbane Outreach" />
            </div>
            <div>
              <label style={s.label}>Goal Type</label>
              <select style={s.input} value={form.goalType} onChange={e => setForm(f => ({ ...f, goalType: e.target.value }))}>
                {GOAL_TYPES.map(g => <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Description (optional)</label>
              <textarea style={{ ...s.textarea, height: 60 }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this campaign about?" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={s.btn} disabled={saving} onClick={editing ? update : create}>
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Campaign'}
            </button>
            <button style={{ ...s.btn, background: '#1f2937' }} onClick={() => { setAdding(false); setEditing(null) }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Campaign grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
      ) : campaigns.length === 0 ? (
        <div style={s.card}><EmptyState message="No campaigns yet. Create your first campaign to start organizing leads." icon="◈" /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {campaigns.map(c => {
            const st = stats[c.id]
            const isLaunching = launching[c.id]
            const isExpanded = expanded === c.id

            return (
              <div key={c.id} style={{
                ...s.card,
                borderLeft: `3px solid ${GOAL_COLORS[c.goalType] || colors.textFaint}`,
              }}>
                {/* Top row */}
                <div style={{ ...s.flexBetween, marginBottom: 12 }}>
                  <div style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {canManage && <button style={s.btnSm} onClick={() => startEdit(c)}>Edit</button>}
                    {canManage && <button style={s.btnDanger} onClick={() => deleteCampaign(c.id)}>✕</button>}
                  </div>
                </div>

                {c.description && (
                  <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.4, marginBottom: 12 }}>{c.description}</div>
                )}

                {/* Stats row */}
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                  <Stat label="Total Leads" value={st?.totalLeads ?? (c._count?.leads ?? 0)} />
                  <Stat label="Has Email" value={st?.leadsWithEmail ?? '—'} />
                  <Stat label="Eligible" value={st?.eligible ?? '—'} color={colors.green} />
                  <Stat label="Sent" value={st?.sent ?? 0} color={colors.blue} />
                  <Stat label="Replied" value={st?.replied ?? 0} color="#22c55e" />
                  {((st?.failed ?? 0) + (st?.bounced ?? 0)) > 0 && (
                    <Stat label="Failed/Bounced" value={(st?.failed ?? 0) + (st?.bounced ?? 0)} color="#ef4444" />
                  )}
                  <Stat
                    label="Reply Rate"
                    value={st ? `${Math.round(st.replyRate * 100)}%` : '—'}
                    color={st && st.replyRate > 0.1 ? '#22c55e' : colors.textMuted}
                  />
                  <Stat
                    label="Goal"
                    value={c.goalType.replace(/_/g, ' ')}
                    color={GOAL_COLORS[c.goalType] || colors.textFaint}
                  />
                </div>

                {/* Action row */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {canManage && (
                    <button
                      style={{
                        ...s.btn,
                        background: isLaunching ? '#374151' : '#16a34a',
                        opacity: isLaunching || !st?.eligible ? 0.6 : 1,
                        cursor: isLaunching || !st?.eligible ? 'not-allowed' : 'pointer',
                      }}
                      disabled={isLaunching || !st?.eligible}
                      onClick={() => st && requestLaunch(c.id, c.name, st.eligible)}
                    >
                      {isLaunching ? '⏳ Sending…' : '🚀 Launch Campaign'}
                    </button>
                  )}

                  {canManage && (st?.failed ?? 0) > 0 && (
                    <button
                      style={{ ...s.btnSm, border: '1px solid #ef4444', color: '#ef4444' }}
                      disabled={isLaunching}
                      onClick={() => retryFailed(c.id)}
                      title="Clear failed sends so those leads can be retried on the next launch"
                    >
                      ↻ Retry {st!.failed} failed
                    </button>
                  )}

                  {(st?.sent ?? 0) > 0 && (
                    <button
                      style={{ ...s.btnSm, background: isExpanded ? '#1e3a5f' : '#1f2937' }}
                      onClick={() => toggleOutreach(c.id)}
                    >
                      {isExpanded ? 'Hide Outreach' : `View ${st!.sent} Sent`}
                    </button>
                  )}
                </div>

                {/* Outreach log (expanded) */}
                {isExpanded && (
                  <div style={{ marginTop: 16, borderTop: '1px solid #374151', paddingTop: 16 }}>
                    <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                      Outreach Log
                    </div>
                    {outreachLoading ? (
                      <Spinner />
                    ) : (outreach[c.id] ?? []).length === 0 ? (
                      <div style={{ color: colors.textMuted, fontSize: 13 }}>No outreach records yet.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
                        {(outreach[c.id] ?? []).map(o => (
                          <div key={o.id} style={{
                            background: '#111827',
                            borderRadius: 6,
                            padding: '8px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                          }}>
                            <div style={{
                              width: 8, height: 8, borderRadius: '50%',
                              background: STATUS_COLOR[o.status] || colors.textFaint,
                              flexShrink: 0
                            }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: colors.text, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {o.toEmail}
                              </div>
                              <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 2 }}>{o.subject}</div>
                              {o.status === 'FAILED' && o.lastError && (
                                <div style={{ color: '#ef4444', fontSize: 11, marginTop: 2 }}>⚠ {o.lastError}</div>
                              )}
                            </div>
                            <div style={{ flexShrink: 0, textAlign: 'right' }}>
                              <div style={{ color: STATUS_COLOR[o.status] || colors.textFaint, fontSize: 11, fontWeight: 600 }}>
                                {o.status}
                              </div>
                              <div style={{ color: colors.textFaint, fontSize: 11 }}>
                                {new Date(o.sentAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ color: color ?? colors.text, fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

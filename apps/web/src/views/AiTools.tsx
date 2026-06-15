import React, { useState, useEffect, useRef } from 'react'
import type { Workspace, Lead } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

type Tab = 'research' | 'outreach' | 'reply'

type JobStatus = {
  jobId: string
  queue: string
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
  progress: number
  result?: unknown
  failedReason?: string
}

const TAB_META: Record<Tab, { label: string; icon: string; description: string }> = {
  research: { label: 'Lead Research', icon: '✦', description: 'Generate AI business intelligence for a prospect' },
  outreach: { label: 'Outreach Copy', icon: '✉', description: 'Write personalised cold email sequences' },
  reply: { label: 'Reply Analysis', icon: '◎', description: 'Classify and action inbound replies' }
}

function JobStatusBadge({ state, progress }: { state: string; progress: number }) {
  const cfg = {
    waiting: { color: colors.textFaint, label: 'Queued' },
    active: { color: colors.amber, label: `Processing (${progress}%)` },
    completed: { color: colors.green, label: 'Complete' },
    failed: { color: colors.red, label: 'Failed' },
    delayed: { color: colors.purple, label: 'Delayed' }
  }[state] ?? { color: colors.textFaint, label: state }

  return (
    <span style={{
      fontSize: 12, fontWeight: 700, color: cfg.color,
      background: cfg.color + '20', padding: '3px 8px', borderRadius: 4
    }}>
      {cfg.label}
    </span>
  )
}

export function AiTools({ api, workspace, toast }: Props) {
  const [tab, setTab] = useState<Tab>('research')
  const [syncMode, setSyncMode] = useState<'sync' | 'async'>('sync')
  const [leads, setLeads] = useState<Lead[]>([])
  const [selectedLeadId, setSelectedLeadId] = useState('')
  const [inputs, setInputs] = useState({ businessName: '', website: '', notes: '', category: '', replyBody: '' })
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!workspace) return
    api<{ leads: Lead[] }>(`/api/leads?workspaceId=${workspace.id}&limit=100`)
      .then(d => setLeads(d.leads || []))
      .catch(() => {})
  }, [workspace?.id])

  // Clear result when tab changes
  useEffect(() => { setResult(null); setActiveJob(null) }, [tab])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  function startPolling(queue: string, jobId: string) {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const status = await api<JobStatus>(`/api/jobs/${queue}/${jobId}`)
        setActiveJob(status)
        if (status.state === 'completed') {
          stopPolling()
          setResult(typeof status.result === 'string' ? status.result : JSON.stringify(status.result, null, 2))
          toast.success('AI job completed')
        } else if (status.state === 'failed') {
          stopPolling()
          toast.error(`AI job failed: ${status.failedReason || 'Unknown error'}`)
        }
      } catch { stopPolling() }
    }, 2000)
  }

  async function runSync() {
    if (!workspace) { toast.error('No workspace selected'); return }
    setLoading(true)
    setResult(null)
    try {
      let data
      if (tab === 'research') {
        data = await api<{ result: string }>('/api/ai/research', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: workspace.id, businessName: inputs.businessName, website: inputs.website, notes: inputs.notes })
        })
      } else if (tab === 'outreach') {
        data = await api<{ result: string }>('/api/ai/outreach', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: workspace.id, businessName: inputs.businessName, category: inputs.category })
        })
      } else {
        data = await api<{ result: string }>('/api/ai/reply-analysis', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: workspace.id, replyBody: inputs.replyBody })
        })
      }
      setResult(typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'AI request failed') }
    finally { setLoading(false) }
  }

  async function runAsync() {
    if (!selectedLeadId) { toast.error('Select a lead first to use async mode'); return }
    setLoading(true)
    setResult(null)
    setActiveJob(null)
    try {
      const endpointMap = { research: 'research', outreach: 'outreach', reply: 'analyze-reply' }
      const queue = tab === 'reply' ? 'analyze-reply' : `${tab === 'research' ? 'research' : 'generate'}-lead`
      const body: Record<string, string> = { leadId: selectedLeadId }
      if (tab === 'reply') body.replyBody = inputs.replyBody

      const data = await api<{ jobId: string; queue: string }>(`/api/jobs/${endpointMap[tab]}`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      setActiveJob({ jobId: data.jobId, queue: data.queue, state: 'waiting', progress: 0 })
      toast.info('Job queued — polling for results…')
      startPolling(data.queue, data.jobId)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to queue job') }
    finally { setLoading(false) }
  }

  function prettyResult(raw: string) {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
  }

  const set = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setInputs(p => ({ ...p, [f]: e.target.value }))

  return (
    <div style={s.stack}>
      {/* Mode + Tab selector */}
      <div style={s.card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          {(Object.keys(TAB_META) as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...s.btnSm,
                background: tab === t ? colors.blue : '#1f2937',
                color: tab === t ? '#fff' : colors.textMuted,
                fontWeight: tab === t ? 700 : 400
              }}
            >
              {TAB_META[t].icon} {TAB_META[t].label}
            </button>
          ))}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, background: '#0b1220', borderRadius: 6, padding: 3 }}>
            {(['sync', 'async'] as const).map(m => (
              <button
                key={m}
                onClick={() => setSyncMode(m)}
                style={{
                  padding: '5px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12,
                  background: syncMode === m ? '#1e293b' : 'transparent',
                  color: syncMode === m ? '#f1f5f9' : colors.textFaint,
                  fontWeight: syncMode === m ? 600 : 400
                }}
              >
                {m === 'sync' ? 'Instant' : 'Queue (async)'}
              </button>
            ))}
          </div>
        </div>

        <p style={{ color: colors.textFaint, fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
          {TAB_META[tab].description}
          {syncMode === 'async' && ' — results are processed in the background and saved to the lead.'}
        </p>

        {/* Lead selector for async mode */}
        {syncMode === 'async' && (
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Select Lead</label>
            <select style={s.input} value={selectedLeadId} onChange={e => setSelectedLeadId(e.target.value)}>
              <option value="">— choose a lead —</option>
              {leads.map(l => <option key={l.id} value={l.id}>{l.businessName}{l.category ? ` (${l.category})` : ''}</option>)}
            </select>
          </div>
        )}

        {/* Inputs */}
        {tab === 'research' && (
          <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={s.label}>Business Name *</label>
              <input style={s.input} value={inputs.businessName} onChange={set('businessName')} placeholder="Acme Plumbing Brisbane" />
            </div>
            <div>
              <label style={s.label}>Website</label>
              <input style={s.input} value={inputs.website} onChange={set('website')} placeholder="https://acmeplumbing.com.au" />
            </div>
            <div>
              <label style={s.label}>Notes</label>
              <input style={s.input} value={inputs.notes} onChange={set('notes')} placeholder="Saw them at BNI, growing fast" />
            </div>
          </div>
        )}

        {tab === 'outreach' && (
          <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={s.label}>Business Name *</label>
              <input style={s.input} value={inputs.businessName} onChange={set('businessName')} />
            </div>
            <div>
              <label style={s.label}>Category / Industry</label>
              <input style={s.input} value={inputs.category} onChange={set('category')} placeholder="Plumbing, Real Estate, Accounting…" />
            </div>
          </div>
        )}

        {tab === 'reply' && (
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Paste Reply Email Body *</label>
            <textarea style={{ ...s.textarea, height: 160 }} value={inputs.replyBody} onChange={set('replyBody')} placeholder="Thanks for reaching out, we're not interested right now…" />
          </div>
        )}

        <button
          style={{ ...s.btn, opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 8 }}
          disabled={loading}
          onClick={syncMode === 'sync' ? runSync : runAsync}
        >
          {loading ? <Spinner size={14} color="#fff" /> : TAB_META[tab].icon}
          {loading ? 'Processing…' : syncMode === 'sync' ? `Run ${TAB_META[tab].label}` : 'Queue Job'}
        </button>
      </div>

      {/* Async job status */}
      {activeJob && (
        <div style={s.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={s.sectionHeader}>Job Status</div>
            <JobStatusBadge state={activeJob.state} progress={activeJob.progress as number} />
            {activeJob.state === 'active' && <Spinner size={14} />}
          </div>
          <div style={{ color: colors.textFaint, fontSize: 12 }}>
            Job ID: {activeJob.jobId} · Queue: {activeJob.queue}
          </div>
          {activeJob.state === 'active' && (
            <div style={{ marginTop: 10 }}>
              <div style={{ background: '#1e2d40', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                <div style={{ width: `${activeJob.progress}%`, height: '100%', background: colors.blue, transition: 'width 0.3s' }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Result panel */}
      {result && (
        <div style={s.card}>
          <div style={{ ...s.flexBetween, marginBottom: 12 }}>
            <div style={s.sectionHeader}>Result</div>
            <button style={s.btnSm} onClick={() => navigator.clipboard.writeText(result).then(() => toast.success('Copied!'))}>
              Copy
            </button>
          </div>
          <pre style={{ color: '#e2e8f0', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, lineHeight: 1.6 }}>
            {prettyResult(result)}
          </pre>
        </div>
      )}
    </div>
  )
}

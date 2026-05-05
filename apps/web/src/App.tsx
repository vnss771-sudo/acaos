import React, { useEffect, useState, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────
type User = { id: string; email: string; name?: string | null }
type Workspace = { id: string; name: string; slug: string }
type Campaign = { id: string; name: string; goalType: string; createdAt: string; _count?: { leads: number } }
type Lead = {
  id: string; businessName: string; contactName?: string | null; email?: string | null
  website?: string | null; city?: string | null; category?: string | null
  stage: string; score: number; aiSummary?: string | null; outreachAngle?: string | null; notes?: string | null
}

type View = 'dashboard' | 'campaigns' | 'leads' | 'ai' | 'billing'

// ── Constants ─────────────────────────────────────────────────────────────────
const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']
const STAGE_COLOR: Record<string, string> = {
  NEW: '#64748b', RESEARCHED: '#3b82f6', OUTREACH_SENT: '#8b5cf6',
  REPLIED: '#f59e0b', BOOKED: '#10b981', CLOSED: '#22c55e', DEAD: '#ef4444'
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: 20 } as React.CSSProperties,
  input: { padding: '10px 14px', borderRadius: 8, border: '1px solid #334155', background: '#0b1220', color: '#e2e8f0', width: '100%', boxSizing: 'border-box' as const, fontSize: 14 },
  btn: { padding: '10px 18px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  btnSm: { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#1f2937', color: '#e2e8f0', cursor: 'pointer', fontSize: 13 },
  btnDanger: { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#7f1d1d', color: '#fca5a5', cursor: 'pointer', fontSize: 13 },
  label: { color: '#94a3b8', fontSize: 13, marginBottom: 4, display: 'block' } as React.CSSProperties,
  badge: (stage: string): React.CSSProperties => ({ background: STAGE_COLOR[stage] || '#64748b', color: '#fff', padding: '2px 8px', borderRadius: 99, fontSize: 12, fontWeight: 600 })
}

// ── API helper ────────────────────────────────────────────────────────────────
function useApi(token: string | null, onUnauth: () => void) {
  return useCallback(async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers || {})
    if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)

    const res = await fetch(`${API}${path}`, { ...init, headers })
    const data = await res.json().catch(() => ({}))

    if (res.status === 401) { onUnauth(); throw new Error('Unauthorized') }
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Request failed')
    return data
  }, [token, onUnauth])
}

// ── Auth screen ───────────────────────────────────────────────────────────────
function AuthScreen({ onToken }: { onToken: (t: string) => void }) {
  const [email, setEmail] = useState('demo@example.com')
  const [password, setPassword] = useState('password123')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function submit(action: 'login' | 'signup') {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`${API}/api/auth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, name: email.split('@')[0] })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      localStorage.setItem('acaos_token', data.token)
      onToken(data.token)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#030712', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ ...s.card, width: 380 }}>
        <h1 style={{ color: '#f1f5f9', marginBottom: 4, fontSize: 22 }}>ACAOS</h1>
        <p style={{ color: '#64748b', marginBottom: 24, fontSize: 14 }}>Agentic Client Acquisition OS</p>
        <div style={{ display: 'grid', gap: 14 }}>
          <div><label style={s.label}>Email</label><input style={s.input} value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div><label style={s.label}>Password</label><input style={s.input} type="password" value={password} onChange={e => setPassword(e.target.value)} /></div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={s.btn} disabled={loading} onClick={() => submit('login')}>{loading ? '...' : 'Login'}</button>
            <button style={{ ...s.btn, background: '#1f2937' }} disabled={loading} onClick={() => submit('signup')}>Sign up</button>
          </div>
          {err && <div style={{ color: '#f87171', fontSize: 13 }}>{err}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '⬡' },
  { id: 'campaigns', label: 'Campaigns', icon: '◈' },
  { id: 'leads', label: 'Leads', icon: '◎' },
  { id: 'ai', label: 'AI Tools', icon: '✦' },
  { id: 'billing', label: 'Billing', icon: '◆' }
]

function Sidebar({ view, setView, email, onLogout }: { view: View; setView: (v: View) => void; email: string; onLogout: () => void }) {
  return (
    <aside style={{ width: 220, background: '#080e1a', borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column', padding: '24px 0' }}>
      <div style={{ padding: '0 20px 24px' }}>
        <div style={{ color: '#2563eb', fontWeight: 800, fontSize: 18, letterSpacing: 1 }}>ACAOS</div>
        <div style={{ color: '#475569', fontSize: 12, marginTop: 2 }}>{email}</div>
      </div>
      {NAV.map(n => (
        <button key={n.id} onClick={() => setView(n.id)} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
          background: view === n.id ? '#1e293b' : 'transparent', border: 'none', cursor: 'pointer',
          color: view === n.id ? '#f1f5f9' : '#64748b', fontSize: 14, fontWeight: view === n.id ? 600 : 400,
          borderLeft: view === n.id ? '2px solid #2563eb' : '2px solid transparent', textAlign: 'left'
        }}>
          <span>{n.icon}</span> {n.label}
        </button>
      ))}
      <div style={{ marginTop: 'auto', padding: '0 20px' }}>
        <button style={{ ...s.btnSm, width: '100%', textAlign: 'center' }} onClick={onLogout}>Logout</button>
      </div>
    </aside>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ workspaces, setView }: { workspaces: Workspace[]; setView: (v: View) => void }) {
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={s.card}>
        <h2 style={{ color: '#f1f5f9', marginBottom: 8 }}>Welcome to ACAOS</h2>
        <p style={{ color: '#64748b', fontSize: 14 }}>Your agentic client acquisition system is running.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {[
          { label: 'Workspaces', value: workspaces.length, action: () => {}, icon: '◈' },
          { label: 'Campaigns', value: '–', action: () => setView('campaigns'), icon: '◉' },
          { label: 'Leads', value: '–', action: () => setView('leads'), icon: '◎' }
        ].map(card => (
          <div key={card.label} style={{ ...s.card, cursor: 'pointer' }} onClick={card.action}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{card.icon}</div>
            <div style={{ color: '#64748b', fontSize: 13 }}>{card.label}</div>
            <div style={{ color: '#f1f5f9', fontSize: 28, fontWeight: 700 }}>{card.value}</div>
          </div>
        ))}
      </div>
      {workspaces.length > 0 && (
        <div style={s.card}>
          <h3 style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12 }}>YOUR WORKSPACES</h3>
          {workspaces.map(w => (
            <div key={w.id} style={{ color: '#e2e8f0', fontSize: 14, padding: '8px 0', borderBottom: '1px solid #1f2937' }}>
              {w.name} <span style={{ color: '#475569', fontSize: 12 }}>/{w.slug}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Campaigns ─────────────────────────────────────────────────────────────────
function Campaigns({ api, workspaces }: { api: ReturnType<typeof useApi>; workspaces: Workspace[] }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [wsId, setWsId] = useState('')
  const [name, setName] = useState('')
  const [goalType, setGoalType] = useState('BOOK_CALL')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (workspaces.length && !wsId) setWsId(workspaces[0].id)
  }, [workspaces])

  useEffect(() => {
    if (!wsId) return
    api(`/api/campaigns?workspaceId=${wsId}`).then(d => setCampaigns(d.campaigns || [])).catch(() => {})
  }, [wsId])

  async function create() {
    if (!name.trim()) return
    setLoading(true); setMsg('')
    try {
      const d = await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ workspaceId: wsId, name, goalType }) })
      setCampaigns(prev => [d.campaign, ...prev])
      setName(''); setMsg('Campaign created')
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  async function deleteCampaign(id: string) {
    await api(`/api/campaigns/${id}`, { method: 'DELETE' })
    setCampaigns(prev => prev.filter(c => c.id !== id))
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={s.card}>
        <h2 style={{ color: '#f1f5f9', marginBottom: 16 }}>New Campaign</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 12, alignItems: 'end' }}>
          <div><label style={s.label}>Workspace</label>
            <select style={s.input} value={wsId} onChange={e => setWsId(e.target.value)}>
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div><label style={s.label}>Campaign Name</label>
            <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Q3 Brisbane Outreach" />
          </div>
          <div><label style={s.label}>Goal</label>
            <select style={s.input} value={goalType} onChange={e => setGoalType(e.target.value)}>
              {['BOOK_CALL', 'GET_REPLY', 'DRIVE_TRAFFIC', 'OTHER'].map(g => <option key={g}>{g}</option>)}
            </select>
          </div>
          <button style={s.btn} disabled={loading} onClick={create}>{loading ? '...' : 'Create'}</button>
        </div>
        {msg && <div style={{ color: '#22c55e', marginTop: 10, fontSize: 13 }}>{msg}</div>}
      </div>
      <div style={s.card}>
        <h3 style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>CAMPAIGNS</h3>
        {campaigns.length === 0 ? <div style={{ color: '#475569' }}>No campaigns yet.</div> : campaigns.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #1f2937' }}>
            <div>
              <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{c.name}</div>
              <div style={{ color: '#64748b', fontSize: 12 }}>{c.goalType} · {c._count?.leads ?? 0} leads</div>
            </div>
            <button style={s.btnDanger} onClick={() => deleteCampaign(c.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Leads ─────────────────────────────────────────────────────────────────────
function Leads({ api, workspaces }: { api: ReturnType<typeof useApi>; workspaces: Workspace[] }) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [wsId, setWsId] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ businessName: '', contactName: '', email: '', website: '', city: '', category: '' })
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { if (workspaces.length && !wsId) setWsId(workspaces[0].id) }, [workspaces])

  const fetchLeads = useCallback(() => {
    if (!wsId) return
    const params = new URLSearchParams({ workspaceId: wsId, page: String(page), limit: '25' })
    if (stageFilter) params.set('stage', stageFilter)
    api(`/api/leads?${params}`).then(d => { setLeads(d.leads || []); setTotal(d.total || 0) }).catch(() => {})
  }, [wsId, page, stageFilter])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  async function addLead() {
    if (!form.businessName.trim()) return
    setLoading(true); setMsg('')
    try {
      const d = await api('/api/leads', { method: 'POST', body: JSON.stringify({ ...form, workspaceId: wsId }) })
      setLeads(prev => [d.lead, ...prev])
      setForm({ businessName: '', contactName: '', email: '', website: '', city: '', category: '' })
      setAdding(false); setMsg('Lead added')
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  async function updateStage(leadId: string, stage: string) {
    const d = await api(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify({ stage }) })
    setLeads(prev => prev.map(l => l.id === leadId ? d.lead : l))
    if (selected?.id === leadId) setSelected(d.lead)
  }

  async function deleteLead(leadId: string) {
    await api(`/api/leads/${leadId}`, { method: 'DELETE' })
    setLeads(prev => prev.filter(l => l.id !== leadId))
    if (selected?.id === leadId) setSelected(null)
  }

  const ff = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Controls */}
      <div style={{ ...s.card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
        <select style={{ ...s.input, width: 180 }} value={wsId} onChange={e => setWsId(e.target.value)}>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select style={{ ...s.input, width: 160 }} value={stageFilter} onChange={e => { setStageFilter(e.target.value); setPage(1) }}>
          <option value="">All stages</option>
          {STAGES.map(s => <option key={s}>{s}</option>)}
        </select>
        <div style={{ color: '#64748b', fontSize: 13 }}>{total} leads</div>
        <button style={{ ...s.btn, marginLeft: 'auto' }} onClick={() => setAdding(v => !v)}>+ Add Lead</button>
      </div>

      {/* Add form */}
      {adding && (
        <div style={s.card}>
          <h3 style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>NEW LEAD</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              { label: 'Business Name *', field: 'businessName' }, { label: 'Contact Name', field: 'contactName' },
              { label: 'Email', field: 'email' }, { label: 'Website', field: 'website' },
              { label: 'City', field: 'city' }, { label: 'Category', field: 'category' }
            ].map(({ label, field }) => (
              <div key={field}><label style={s.label}>{label}</label>
                <input style={s.input} value={(form as Record<string, string>)[field]} onChange={ff(field)} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
            <button style={s.btn} disabled={loading} onClick={addLead}>{loading ? '...' : 'Save Lead'}</button>
            <button style={{ ...s.btn, background: '#1f2937' }} onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {msg && <div style={{ color: '#22c55e', marginTop: 8, fontSize: 13 }}>{msg}</div>}
        </div>
      )}

      {/* Table */}
      <div style={s.card}>
        {leads.length === 0 ? <div style={{ color: '#475569' }}>No leads found.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#64748b', fontSize: 12, textAlign: 'left' }}>
                {['Business', 'Contact', 'Email', 'Category', 'Stage', 'Score', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', borderBottom: '1px solid #1f2937' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr key={lead.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(lead)}>
                  <td style={{ padding: '10px 12px', color: '#e2e8f0', fontSize: 14 }}>{lead.businessName}</td>
                  <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 13 }}>{lead.contactName || '–'}</td>
                  <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 13 }}>{lead.email || '–'}</td>
                  <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>{lead.category || '–'}</td>
                  <td style={{ padding: '10px 12px' }}><span style={s.badge(lead.stage)}>{lead.stage}</span></td>
                  <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 13 }}>{lead.score}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <button style={s.btnDanger} onClick={e => { e.stopPropagation(); deleteLead(lead.id) }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {total > 25 && (
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: '#64748b', fontSize: 13, lineHeight: '30px' }}>Page {page}</span>
            <button style={s.btnSm} disabled={leads.length < 25} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      {/* Lead detail panel */}
      {selected && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <h3 style={{ color: '#f1f5f9' }}>{selected.businessName}</h3>
            <button style={s.btnSm} onClick={() => setSelected(null)}>✕ Close</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Email', value: selected.email }, { label: 'Website', value: selected.website },
              { label: 'City', value: selected.city }, { label: 'Category', value: selected.category },
              { label: 'Contact', value: selected.contactName }
            ].map(({ label, value }) => value ? (
              <div key={label}><span style={{ ...s.label, display: 'inline' }}>{label}: </span>
                <span style={{ color: '#e2e8f0', fontSize: 14 }}>{value}</span></div>
            ) : null)}
          </div>
          {selected.aiSummary && <div style={{ ...s.card, background: '#0f172a', marginBottom: 12 }}>
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 4 }}>AI SUMMARY</div>
            <div style={{ color: '#cbd5e1', fontSize: 14 }}>{selected.aiSummary}</div>
          </div>}
          {selected.outreachAngle && <div style={{ ...s.card, background: '#0f172a', marginBottom: 12 }}>
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 4 }}>OUTREACH ANGLE</div>
            <div style={{ color: '#cbd5e1', fontSize: 14 }}>{selected.outreachAngle}</div>
          </div>}
          <div style={{ marginTop: 8 }}>
            <label style={s.label}>Move stage</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              {STAGES.map(stage => (
                <button key={stage} style={{ ...s.btnSm, background: selected.stage === stage ? (STAGE_COLOR[stage] || '#64748b') : '#1f2937', color: selected.stage === stage ? '#fff' : '#94a3b8' }}
                  onClick={() => updateStage(selected.id, stage)}>{stage}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── AI Tools ──────────────────────────────────────────────────────────────────
function AiTools({ api }: { api: ReturnType<typeof useApi> }) {
  const [tab, setTab] = useState<'research' | 'outreach' | 'reply'>('research')
  const [inputs, setInputs] = useState({ businessName: '', website: '', notes: '', category: '', replyBody: '' })
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setInputs(prev => ({ ...prev, [field]: e.target.value }))

  async function run() {
    setLoading(true); setResult(null); setErr('')
    try {
      let data
      if (tab === 'research') data = await api('/api/ai/research', { method: 'POST', body: JSON.stringify({ businessName: inputs.businessName, website: inputs.website, notes: inputs.notes }) })
      else if (tab === 'outreach') data = await api('/api/ai/outreach', { method: 'POST', body: JSON.stringify({ businessName: inputs.businessName, category: inputs.category }) })
      else data = await api('/api/ai/reply-analysis', { method: 'POST', body: JSON.stringify({ replyBody: inputs.replyBody }) })
      setResult(typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={s.card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['research', 'outreach', 'reply'] as const).map(t => (
            <button key={t} style={{ ...s.btnSm, background: tab === t ? '#2563eb' : '#1f2937', color: tab === t ? '#fff' : '#94a3b8' }} onClick={() => { setTab(t); setResult(null) }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        {tab === 'research' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div><label style={s.label}>Business Name</label><input style={s.input} value={inputs.businessName} onChange={set('businessName')} placeholder="Acme Plumbing Brisbane" /></div>
            <div><label style={s.label}>Website</label><input style={s.input} value={inputs.website} onChange={set('website')} placeholder="https://acmeplumbing.com.au" /></div>
            <div><label style={s.label}>Notes</label><input style={s.input} value={inputs.notes} onChange={set('notes')} placeholder="Saw them at BNI, growing fast" /></div>
          </div>
        )}
        {tab === 'outreach' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div><label style={s.label}>Business Name</label><input style={s.input} value={inputs.businessName} onChange={set('businessName')} /></div>
            <div><label style={s.label}>Category</label><input style={s.input} value={inputs.category} onChange={set('category')} placeholder="Plumbing, Real Estate, Accounting..." /></div>
          </div>
        )}
        {tab === 'reply' && (
          <div><label style={s.label}>Paste Reply Email Body</label>
            <textarea style={{ ...s.input, height: 140, resize: 'vertical' as const }} value={inputs.replyBody} onChange={set('replyBody')} placeholder="Thanks for reaching out, we're not interested right now..." />
          </div>
        )}
        <button style={{ ...s.btn, marginTop: 16 }} disabled={loading} onClick={run}>{loading ? 'Running AI...' : '✦ Run'}</button>
        {err && <div style={{ color: '#f87171', marginTop: 10, fontSize: 13 }}>{err}</div>}
      </div>
      {result && (
        <div style={s.card}>
          <div style={{ color: '#64748b', fontSize: 12, marginBottom: 8 }}>RESULT</div>
          <pre style={{ color: '#e2e8f0', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{result}</pre>
        </div>
      )}
    </div>
  )
}

// ── Billing ───────────────────────────────────────────────────────────────────
function Billing({ api, workspaces }: { api: ReturnType<typeof useApi>; workspaces: Workspace[] }) {
  const [wsId, setWsId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (workspaces.length && !wsId) setWsId(workspaces[0].id) }, [workspaces])

  async function startCheckout() {
    setLoading(true); setErr('')
    try {
      const d = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ workspaceId: wsId }) })
      window.location.href = d.url
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  return (
    <div style={s.card}>
      <h2 style={{ color: '#f1f5f9', marginBottom: 16 }}>Upgrade to Pro</h2>
      <p style={{ color: '#64748b', fontSize: 14, marginBottom: 20 }}>Unlock unlimited campaigns, bulk lead import, and priority AI processing.</p>
      <div style={{ marginBottom: 16 }}>
        <label style={s.label}>Workspace</label>
        <select style={{ ...s.input, width: 240 }} value={wsId} onChange={e => setWsId(e.target.value)}>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      <button style={s.btn} disabled={loading} onClick={startCheckout}>{loading ? '...' : 'Start Checkout →'}</button>
      {err && <div style={{ color: '#f87171', marginTop: 10, fontSize: 13 }}>{err}</div>}
    </div>
  )
}

// ── App root ──────────────────────────────────────────────────────────────────
export function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('acaos_token'))
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [view, setView] = useState<View>('dashboard')

  function logout() {
    localStorage.removeItem('acaos_token')
    setToken(null); setUser(null); setWorkspaces([])
  }

  const api = useApi(token, logout)

  useEffect(() => {
    if (!token) return
    api('/api/auth/me').then(d => {
      setUser(d.user)
      setWorkspaces(Array.isArray(d.workspaces) ? d.workspaces : [])
    }).catch(() => logout())
  }, [token])

  if (!token || !user) return <AuthScreen onToken={t => { setToken(t) }} />

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#030712', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }}>
      <Sidebar view={view} setView={setView} email={user.email} onLogout={logout} />
      <main style={{ flex: 1, padding: 28, overflowY: 'auto', maxWidth: 1100 }}>
        <h1 style={{ color: '#94a3b8', fontSize: 12, letterSpacing: 2, marginBottom: 20, fontWeight: 600 }}>
          {view.toUpperCase()}
        </h1>
        {view === 'dashboard' && <Dashboard workspaces={workspaces} setView={setView} />}
        {view === 'campaigns' && <Campaigns api={api} workspaces={workspaces} />}
        {view === 'leads' && <Leads api={api} workspaces={workspaces} />}
        {view === 'ai' && <AiTools api={api} />}
        {view === 'billing' && <Billing api={api} workspaces={workspaces} />}
      </main>
    </div>
  )
}

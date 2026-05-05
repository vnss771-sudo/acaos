import React, { useEffect, useState } from 'react'
import type { Campaign, Workspace } from '../types.js'
import { GOAL_TYPES } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

export function Campaigns({ api, workspace, toast }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Campaign | null>(null)
  const [form, setForm] = useState({ name: '', goalType: 'BOOK_CALL', description: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!workspace) return
    setLoading(true)
    api<{ campaigns: Campaign[] }>(`/api/campaigns?workspaceId=${workspace.id}`)
      .then(d => setCampaigns(d.campaigns || []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [workspace?.id])

  async function create() {
    if (!form.name.trim() || !workspace) return
    setSaving(true)
    try {
      const d = await api<{ campaign: Campaign }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id, name: form.name, goalType: form.goalType, description: form.description })
      })
      setCampaigns(prev => [d.campaign, ...prev])
      setForm({ name: '', goalType: 'BOOK_CALL', description: '' })
      setAdding(false)
      toast.success('Campaign created')
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

  const GOAL_COLORS: Record<string, string> = {
    BOOK_CALL: colors.blue, GET_REPLY: colors.purple,
    DRIVE_TRAFFIC: colors.green, OTHER: colors.textFaint
  }

  return (
    <div style={s.stack}>
      {/* Header */}
      <div style={{ ...s.flexBetween }}>
        <div />
        <button style={s.btn} onClick={startAdd}>+ New Campaign</button>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {campaigns.map(c => (
            <div key={c.id} style={{
              ...s.card,
              borderLeft: `3px solid ${GOAL_COLORS[c.goalType] || colors.textFaint}`,
              display: 'flex', flexDirection: 'column', gap: 12
            }}>
              <div style={s.flexBetween}>
                <div style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={s.btnSm} onClick={() => startEdit(c)}>Edit</button>
                  <button style={s.btnDanger} onClick={() => deleteCampaign(c.id)}>✕</button>
                </div>
              </div>

              {c.description && (
                <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.4 }}>{c.description}</div>
              )}

              <div style={{ display: 'flex', gap: 16, marginTop: 'auto' }}>
                <div>
                  <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Goal</div>
                  <div style={{ color: GOAL_COLORS[c.goalType] || colors.textFaint, fontSize: 12, fontWeight: 600, marginTop: 2 }}>
                    {c.goalType.replace(/_/g, ' ')}
                  </div>
                </div>
                <div>
                  <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Leads</div>
                  <div style={{ color: colors.text, fontSize: 20, fontWeight: 700, marginTop: 2 }}>{c._count?.leads ?? 0}</div>
                </div>
                <div>
                  <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Created</div>
                  <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                    {new Date(c.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

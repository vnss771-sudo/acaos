import React, { useEffect, useMemo, useState } from 'react'
import type { UpdateDiscoveryProfileRequest } from '@acaos/shared'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { makeRouteApi } from '../lib/routeApi.js'
import { colors, s } from '../styles.js'

// Onboarding for a trade business: what work to look for and where. Saves the
// Find work discovery profile, then shows the loop the product runs, so the
// first screen after setup is work to win, not an empty dashboard.

type ProfileMeta = {
  trades: { id: string; label: string }[]
  regions: string[]
  sources: { name: string; label: string; configured: boolean }[]
}

export const CONTRACTOR_LOOP: { title: string; text: string }[] = [
  { title: 'Find work', text: 'Tenders and development applications for your trade, every morning.' },
  { title: 'Pursue & quote', text: 'Call the builder, record your price and estimated hours.' },
  { title: 'Win & start the job', text: 'Client accepted? One click turns the quote into a job.' },
  { title: 'Crew & shifts', text: 'Roster your crew and log hours against the job.' },
  { title: 'Close out', text: 'Enter the invoice and costs when it’s done.' },
  { title: 'See your margin', text: 'Learn which work actually pays — by where it came from.' },
]

function toggle(list: string[], v: string) {
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
}

export function ContractorSetup({ api, toast, workspaceId, onSaved, onBack }: {
  api: ApiHook
  toast: ToastHook
  workspaceId: string
  onSaved: () => Promise<void> | void
  onBack: () => void
}) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [meta, setMeta] = useState<ProfileMeta | null>(null)
  const [trades, setTrades] = useState<string[]>([])
  const [regions, setRegions] = useState<string[]>([])
  const [keywords, setKeywords] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<ProfileMeta>(`/api/opportunities/profile?workspaceId=${workspaceId}`)
      .then(setMeta)
      .catch(() => toast.error('Could not load the trade list — you can set this up later in Find work'))
  }, [workspaceId])

  async function save() {
    if (trades.length === 0) { toast.error('Pick at least one trade'); return }
    const body: UpdateDiscoveryProfileRequest = {
      workspaceId,
      enabled: true,
      trades,
      keywords: keywords.split(',').map(k => k.trim()).filter(k => k.length >= 2),
      regions: regions as UpdateDiscoveryProfileRequest['regions'],
      // Search every source; ones not configured on this server are skipped, not errors.
      sources: (meta?.sources ?? []).map(src => src.name),
    }
    setSaving(true)
    try {
      await route('PUT /api/opportunities/profile', { body })
      await onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save your trades') }
    finally { setSaving(false) }
  }

  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 6px' }}>What work do you want?</h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
        We search government contracts and council development applications for jobs that match your trade and area.
      </p>

      <div style={s.label}>Your trades</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 16px' }}>
        {!meta && <span style={{ color: colors.textFaint, fontSize: 12 }}>Loading…</span>}
        {meta?.trades.map(t => (
          <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: colors.text, border: `1px solid ${trades.includes(t.id) ? colors.blue : colors.border}`, borderRadius: 999, padding: '4px 10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={trades.includes(t.id)} onChange={() => setTrades(x => toggle(x, t.id))} />
            {t.label}
          </label>
        ))}
      </div>

      <div style={s.label}>Where you work (leave blank for anywhere)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 16px' }}>
        {meta?.regions.map(r => (
          <label key={r} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: colors.text, border: `1px solid ${regions.includes(r) ? colors.blue : colors.border}`, borderRadius: 999, padding: '4px 10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={regions.includes(r)} onChange={() => setRegions(x => toggle(x, r))} />
            {r}
          </label>
        ))}
      </div>

      <label style={s.label} htmlFor="cs-keywords">Extra keywords (optional, comma separated)</label>
      <input id="cs-keywords" style={{ ...s.input, marginBottom: 20 }} value={keywords} placeholder="e.g. switchboard, fit-out, solar" onChange={e => setKeywords(e.target.value)} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button style={s.btnGhost} onClick={onBack} disabled={saving}>← Back</button>
        <button style={s.btn} onClick={save} disabled={saving || !meta}>{saving ? 'Saving…' : 'Start finding work →'}</button>
      </div>
    </div>
  )
}

export function ContractorDone({ onGo }: { onGo: () => void }) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>You’re set up</h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
        Here’s how a job moves through ACAOS — every step is one click from the last.
      </p>
      <ol style={{ margin: '0 0 20px', paddingLeft: 18, color: colors.text, fontSize: 13, lineHeight: 1.6 }}>
        {CONTRACTOR_LOOP.map(step => (
          <li key={step.title}><strong>{step.title}</strong> <span style={{ color: colors.textMuted }}>— {step.text}</span></li>
        ))}
      </ol>
      <button style={{ ...s.btn, width: '100%' }} onClick={onGo}>Go to Find work →</button>
    </div>
  )
}

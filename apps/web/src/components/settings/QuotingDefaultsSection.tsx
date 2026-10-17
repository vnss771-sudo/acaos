import React, { useEffect, useMemo, useState } from 'react'
import type { QuotingDefaults } from '@acaos/shared'
import { s, colors } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

// Quoting defaults: the on-cost %, overhead % and target gross margin % the
// estimate builder starts from. Optional: blank means no default (the builder
// field starts blank), 0 is a real 0. Each quote can override them, and saved
// estimates keep their own figures, so changing a default never alters a quote.

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook }
type Key = keyof QuotingDefaults
const FIELDS: Array<{ key: Key; label: string; max: number; hint: string }> = [
  { key: 'defaultOnCostPct', label: 'Labour on-costs (%)', max: 200, hint: 'Super, workers’ comp, payroll tax, leave… as a % of base pay' },
  { key: 'defaultOverheadPct', label: 'Overheads (% of direct cost)', max: 200, hint: 'Vehicles, insurance, office and admin recovered on each job' },
  { key: 'defaultTargetMarginPct', label: 'Target gross margin (%)', max: 95, hint: 'The gross margin you aim to leave after labour, materials and subcontractors' },
]

/** Text field → default: blank is null (not set), never 0; anything not a number in range is an error. */
export function parseDefault(text: string, max: number): number | null | 'invalid' {
  const t = text.replace(/[%\s]/g, '')
  if (t === '') return null
  if (!/^\d+(\.\d+)?$/.test(t)) return 'invalid'
  const n = Number(t)
  return n >= 0 && n <= max ? n : 'invalid'
}

const toText = (v: number | null) => (v == null ? '' : String(v))

export function QuotingDefaultsSection({ api, workspaceId, toast }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [form, setForm] = useState<Record<Key, string> | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    route('GET /api/workspaces/:id/quoting-defaults', { params: { id: workspaceId } })
      .then(r => { if (live) setForm({ defaultOnCostPct: toText(r.defaults.defaultOnCostPct), defaultOverheadPct: toText(r.defaults.defaultOverheadPct), defaultTargetMarginPct: toText(r.defaults.defaultTargetMarginPct) }) })
      .catch(() => { if (live) toast.error('Could not load quoting defaults') })
    return () => { live = false }
  }, [route, workspaceId, toast])

  async function save() {
    if (!form) return
    const body = {} as QuotingDefaults
    for (const f of FIELDS) {
      const v = parseDefault(form[f.key], f.max)
      if (v === 'invalid') { toast.error(`${f.label} must be a number from 0 to ${f.max}, or blank for no default`); return }
      body[f.key] = v
    }
    setSaving(true)
    try {
      const r = await route('PUT /api/workspaces/:id/quoting-defaults', { params: { id: workspaceId }, body })
      setForm({ defaultOnCostPct: toText(r.defaults.defaultOnCostPct), defaultOverheadPct: toText(r.defaults.defaultOverheadPct), defaultTargetMarginPct: toText(r.defaults.defaultTargetMarginPct) })
      toast.success('Quoting defaults saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save quoting defaults') }
    finally { setSaving(false) }
  }

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Quoting defaults</div>
      <p style={{ fontSize: 13, color: colors.textMuted, margin: '0 0 12px' }}>
        Filled in when you build a quote estimate, and changeable on each quote. Leave a field blank for no default.
        Changing these never changes a quote you have already saved.
      </p>
      {!form ? <span style={{ fontSize: 13, color: colors.textFaint }}>Loading…</span> : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {FIELDS.map(f => (
            <div key={f.key} style={{ minWidth: 0, flex: '1 1 180px' }}>
              <label style={s.label} htmlFor={`qd-${f.key}`}>{f.label}</label>
              <input id={`qd-${f.key}`} style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} inputMode="decimal" placeholder="Not set"
                value={form[f.key]} onChange={e => setForm(prev => (prev ? { ...prev, [f.key]: e.target.value } : prev))} />
              <span style={{ fontSize: 11, color: colors.textFaint }}>{f.hint}</span>
            </div>
          ))}
          <button style={s.btnSm} disabled={saving} onClick={save}>Save quoting defaults</button>
        </div>
      )}
    </div>
  )
}

import React, { useMemo, useState } from 'react'
import type { OnboardingImportRequest } from '@acaos/shared'
import { makeRouteApi } from '../lib/routeApi.js'
import { colors, s } from '../styles.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

// Mirrors the server's ONBOARDING_MAX_ROWS.
const MAX_ROWS = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Row = { companyName: string; contactName: string; contactEmail: string; domain: string }
const emptyRow = (): Row => ({ companyName: '', contactName: '', contactEmail: '', domain: '' })

type Props = {
  api: ApiHook
  workspaceId: string
  toast: ToastHook
  onDone: (preparedCount: number) => void
  onSkip: () => void
}

// A new workspace's first real prospects. The server imports and scores them as
// usual, then prepares outreach for the top few so the customer can take one all
// the way to a sent email on their own data.
export function FirstProspectsForm({ api, workspaceId, toast, onDone, onSkip }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [saving, setSaving] = useState(false)

  const filled = rows.filter((r) => r.companyName.trim() || r.contactEmail.trim())
  const invalid = filled.some((r) => !r.companyName.trim() || !EMAIL_RE.test(r.contactEmail.trim()))
  const canSubmit = filled.length > 0 && !invalid && !saving

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  async function submit() {
    setSaving(true)
    try {
      const body: OnboardingImportRequest = {
        workspaceId,
        rows: filled.map((r) => ({
          companyName: r.companyName.trim(),
          contactEmail: r.contactEmail.trim(),
          ...(r.contactName.trim() ? { contactName: r.contactName.trim() } : {}),
          ...(r.domain.trim() ? { domain: r.domain.trim() } : {}),
          sourceTag: 'onboarding',
        })),
      }
      const res = await route('POST /api/prospects/onboarding-import', { body })
      toast.success(`Prepared ${res.intents.length} ${res.intents.length === 1 ? 'opportunity' : 'opportunities'} on your dashboard`)
      onDone(res.intents.length)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add prospects')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = { ...s.input, marginBottom: 0 }
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Your first prospects</h2>
      <p style={{ color: colors.textMuted, fontSize: 14, margin: '0 0 16px', lineHeight: 1.5 }}>
        Add a few real companies you’d like to reach. We’ll prepare your first few opportunities so you can see how
        ACAOS works — you review and approve every email before anything is sent.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <input style={inputStyle} aria-label={`Company ${i + 1}`} placeholder="Company" value={r.companyName} onChange={(e) => update(i, { companyName: e.target.value })} />
            <input style={inputStyle} aria-label={`Contact email ${i + 1}`} placeholder="Contact email" type="email" value={r.contactEmail} onChange={(e) => update(i, { contactEmail: e.target.value })} />
            <input style={inputStyle} aria-label={`Contact name ${i + 1}`} placeholder="Contact name (optional)" value={r.contactName} onChange={(e) => update(i, { contactName: e.target.value })} />
            <input style={inputStyle} aria-label={`Website ${i + 1}`} placeholder="Website (optional)" value={r.domain} onChange={(e) => update(i, { domain: e.target.value })} />
          </div>
        ))}
      </div>
      {rows.length < MAX_ROWS && (
        <button style={{ ...s.btnSecondary, marginTop: 12 }} onClick={() => setRows((rs) => [...rs, emptyRow()])}>+ Add another</button>
      )}
      {invalid && <div style={{ color: colors.amber, fontSize: 12, marginTop: 8 }}>Each prospect needs a company name and a valid email.</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
        <button style={s.btnSecondary} onClick={onSkip} disabled={saving}>Skip for now</button>
        <button style={s.btn} onClick={submit} disabled={!canSubmit}>{saving ? 'Preparing…' : 'Prepare my first emails'}</button>
      </div>
    </div>
  )
}

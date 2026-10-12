import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import { Badge } from '../ui/Badge.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { Workspace } from '../../types.js'

// Settings → Compliance → Australia (Spam Act 2003). Sender identity + ABN verification, Australian
// targeting, and consent-evidence entry/review. This component NEVER decides whether something is
// valid: it submits to the existing compliance API, which validates (lib/auConsent.ts, lib/abnLookup.ts)
// and returns the verdict. The ABR GUID lives only on the server.

export type AuPosture = {
  targetsAustralia: boolean
  senderAbn: string | null
  senderAbnStatus: string | null
  senderAbnEntityName: string | null
  senderAbnVerifiedAt: string | null
}

type ConsentRow = {
  id: string; email: string; basis: string; source: string; recordedAt: string
  evidenceUrl: string | null; evidenceAt: string | null; evidenceExcerpt: string | null
  addressType: string | null; optOutStatementAbsent: boolean | null; roleRelevant: boolean | null
  qualifiesForAustralia: boolean; australiaReasons: string[]
}
type Check = { name: string; label: string; ok: boolean; hint?: string }
type Readiness = { ready: boolean; checks: Check[] }

type Props = {
  api: ApiHook
  workspace: Workspace
  toast: ToastHook
  canManage: boolean
  posture: AuPosture
  onPosture: (patch: Partial<AuPosture>) => void
}

const BASIS_LABELS: Record<string, string> = {
  express: 'Express consent (the person agreed)',
  inferred_conspicuous_publication: 'Inferred: address conspicuously published',
  express_consent: 'Express consent (legacy / Canada)',
  implied_consent: 'Implied consent (legacy / Canada)',
  legitimate_interest: 'Legitimate interest (does NOT count for Australia)',
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—')
const spacedAbn = (abn: string) => abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4')

export function AuComplianceSection({ api, workspace, toast, canManage, posture, onPosture }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])

  // ── sender identity + ABN ──────────────────────────────────────────────────
  const [legalName, setLegalName] = useState(workspace.senderBusinessName ?? '')
  const [savingName, setSavingName] = useState(false)
  const [abn, setAbn] = useState(posture.senderAbn ? spacedAbn(posture.senderAbn) : '')
  const [abnState, setAbnState] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' })

  async function saveName() {
    setSavingName(true)
    try {
      await route('PATCH /api/workspaces/:id', { params: { id: workspace.id }, body: { senderBusinessName: legalName.trim() || null } })
      toast.success('Sender legal name saved')
    } catch (e) {
      if (e instanceof Error && e.name !== 'ReauthRequiredError') toast.error(e.message)
    } finally { setSavingName(false) }
  }

  async function verifyAbn() {
    setAbnState({ kind: 'loading' })
    try {
      const r = await route('POST /api/workspaces/:id/compliance/abn', { params: { id: workspace.id }, body: { abn } })
      onPosture({
        senderAbn: r.abn, senderAbnStatus: r.status, senderAbnEntityName: r.entityName,
        senderAbnVerifiedAt: new Date().toISOString(),
      })
      setAbn(spacedAbn(r.abn))
      setAbnState({ kind: 'idle' })
      toast.success('ABN verified')
    } catch (e) {
      // Server messages are written for operators (invalid checksum, not found, cancelled, register
      // unreachable, not configured); show them verbatim.
      setAbnState({ kind: 'error', message: e instanceof Error ? e.message : 'ABN verification failed' })
      // A cancelled ABN clears any stored one server-side.
      if (e instanceof Error && /cancelled/i.test(e.message)) {
        onPosture({ senderAbn: null, senderAbnStatus: null, senderAbnEntityName: null, senderAbnVerifiedAt: null })
      }
    }
  }

  // ── Australian targeting ───────────────────────────────────────────────────
  const [savingTargeting, setSavingTargeting] = useState(false)
  async function setTargeting(next: boolean) {
    setSavingTargeting(true)
    try {
      await route('PATCH /api/workspaces/:id/compliance', { params: { id: workspace.id }, body: { targetsAustralia: next } })
      onPosture({ targetsAustralia: next })
      toast.success(next ? 'Australian targeting enabled' : 'Australian targeting disabled')
      void loadReadiness()
    } catch (e) {
      if (e instanceof Error && e.name !== 'ReauthRequiredError') toast.error(e.message)
    } finally { setSavingTargeting(false) }
  }

  // ── readiness + consent review ─────────────────────────────────────────────
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [records, setRecords] = useState<ConsentRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [listError, setListError] = useState('')

  const loadReadiness = useCallback(async () => {
    try { setReadiness(await api<Readiness>(`/api/campaigns/send-readiness?workspaceId=${encodeURIComponent(workspace.id)}`)) } catch { /* shown as unavailable */ }
  }, [api, workspace.id])
  const loadRecords = useCallback(async () => {
    try {
      const r = await api<{ total: number; records: ConsentRow[] }>(`/api/workspaces/${workspace.id}/consent?limit=50`)
      setRecords(r.records); setTotal(r.total); setListError('')
    } catch (e) { setListError(e instanceof Error ? e.message : 'Could not load consent records') }
  }, [api, workspace.id])
  useEffect(() => { void loadReadiness(); void loadRecords() }, [loadReadiness, loadRecords, posture.senderAbnStatus])

  // ── evidence form ──────────────────────────────────────────────────────────
  const blank = { email: '', basis: 'inferred_conspicuous_publication', evidenceUrl: '', evidenceAt: '', evidenceExcerpt: '', addressType: '', optOutStatementAbsent: false, roleRelevant: false }
  const [form, setForm] = useState(blank)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const isPublication = form.basis === 'inferred_conspicuous_publication'

  async function submitEvidence(e: React.FormEvent) {
    e.preventDefault()
    setFormError(''); setSubmitting(true)
    try {
      await route('POST /api/workspaces/:id/consent', {
        params: { id: workspace.id },
        body: {
          email: form.email, basis: form.basis, source: 'manual',
          ...(form.evidenceUrl ? { evidenceUrl: form.evidenceUrl } : {}),
          ...(form.evidenceAt ? { evidenceAt: new Date(form.evidenceAt).toISOString() } : {}),
          ...(form.evidenceExcerpt ? { evidenceExcerpt: form.evidenceExcerpt } : {}),
          ...(isPublication && form.addressType ? { addressType: form.addressType as 'role' | 'personal' } : {}),
          ...(isPublication ? { optOutStatementAbsent: form.optOutStatementAbsent, roleRelevant: form.roleRelevant } : {}),
        },
      })
      toast.success('Consent evidence recorded')
      setForm(blank)
      await loadRecords()
    } catch (err) {
      // The API is the authority: it rejects (400) anything that would not satisfy the Spam Act evidence rules.
      if (err instanceof Error && err.name !== 'ReauthRequiredError') setFormError(err.message)
    } finally { setSubmitting(false) }
  }

  const auCheck = readiness?.checks.find(c => c.name === 'auCommercialSending')
  const abnActive = posture.senderAbnStatus === 'active' && !!posture.senderAbn
  const field = (id: string, label: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={id} style={{ display: 'block', color: colors.textMuted, fontSize: 13, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )

  return (
    <div style={{ ...s.card, marginTop: 16 }} aria-label="Australian compliance">
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 4 }}>Australia (Spam Act 2003)</div>
      <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 16 }}>
        Sender identity, Australian targeting and per-recipient consent evidence. The server validates everything you enter here.
        This is not legal advice.
      </div>

      {/* Sender identity */}
      <div style={{ fontWeight: 600, color: colors.text, fontSize: 13, marginBottom: 8 }}>Sender identity</div>
      {field('au-legal-name', 'Business legal name', (
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="au-legal-name" style={s.input} value={legalName} disabled={!canManage} maxLength={200}
            placeholder="Acme Electrical Pty Ltd" onChange={e => setLegalName(e.target.value)} />
          <button style={s.btnSm} disabled={!canManage || savingName} onClick={saveName}>{savingName ? <Spinner size={12} /> : 'Save'}</button>
        </div>
      ))}
      {field('au-abn', 'ABN', (
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="au-abn" style={s.input} value={abn} disabled={!canManage || abnState.kind === 'loading'} inputMode="numeric"
            placeholder="51 824 753 556" onChange={e => { setAbn(e.target.value); if (abnState.kind === 'error') setAbnState({ kind: 'idle' }) }} />
          <button style={s.btnSm} disabled={!canManage || abnState.kind === 'loading' || abn.trim() === ''} onClick={verifyAbn}>
            {abnState.kind === 'loading' ? <><Spinner size={12} /> Verifying…</> : 'Verify ABN'}
          </button>
        </div>
      ))}
      <div role="status" aria-live="polite" style={{ minHeight: 18, marginBottom: 6 }}>
        {abnState.kind === 'loading' && <span style={{ color: colors.textMuted, fontSize: 12 }}>Checking the Australian Business Register…</span>}
      </div>
      {abnState.kind === 'error' && (
        <div role="alert" style={{ color: colors.red, fontSize: 13, marginBottom: 10 }}>{abnState.message}</div>
      )}
      {abnActive ? (
        <div style={{ ...s.cardInner, marginBottom: 12 }}>
          <div style={{ color: colors.green, fontSize: 13, fontWeight: 600 }}>✓ ABN verified</div>
          <div style={{ color: colors.text, fontSize: 13 }}>{posture.senderAbnEntityName}</div>
          <div style={{ color: colors.textMuted, fontSize: 12 }}>
            ABN {spacedAbn(posture.senderAbn!)} · <Badge color={colors.greenDark}>Active</Badge> · verified {fmtDate(posture.senderAbnVerifiedAt)}
          </div>
          <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
            Shown in your email footer. Source: ABN Lookup. This does not mean the Commonwealth endorses or is affiliated with your business.
          </div>
        </div>
      ) : (
        <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 12 }}>
          No verified ABN. Emails identify you by business name and postal address only.
        </div>
      )}

      {/* Targeting */}
      <div style={{ fontWeight: 600, color: colors.text, fontSize: 13, margin: '14px 0 8px' }}>Australian recipients</div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: colors.text, fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={posture.targetsAustralia} disabled={!canManage || savingTargeting}
          onChange={e => setTargeting(e.target.checked)} />
        <span>We send to recipients with an Australian link (requires documented consent per recipient)</span>
      </label>
      {posture.targetsAustralia && (
        <div role="note" style={{ color: colors.amber, fontSize: 12, marginBottom: 10 }}>
          {auCheck && !auCheck.ok
            ? 'Sending is currently blocked for this workspace: Australian commercial sending is disabled on this ACAOS deployment pending legal review. Nothing you enter here changes that.'
            : 'Each recipient needs qualifying consent evidence below, otherwise their message is skipped (AU_CONSENT_REQUIRED).'}
        </div>
      )}

      {/* Consent evidence */}
      <div style={{ fontWeight: 600, color: colors.text, fontSize: 13, margin: '14px 0 4px' }}>Consent evidence</div>
      <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 10 }}>
        Publication of an email address is <strong>not</strong> consent on its own. For an address published on a website you must record where and when you
        saw it, whether it is a role address or the person’s own, that no “no unsolicited commercial email” statement accompanies it, and that your message
        is relevant to their role. Legitimate interest never counts for Australia.
      </div>
      {canManage && (
        <form onSubmit={submitEvidence} aria-label="Record consent evidence">
          {field('au-ev-email', 'Recipient email', <input id="au-ev-email" style={s.input} type="email" required value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />)}
          {field('au-ev-basis', 'Basis', (
            <select id="au-ev-basis" style={s.input} value={form.basis} onChange={e => setForm(f => ({ ...f, basis: e.target.value }))}>
              <option value="inferred_conspicuous_publication">{BASIS_LABELS.inferred_conspicuous_publication}</option>
              <option value="express">{BASIS_LABELS.express}</option>
            </select>
          ))}
          {field('au-ev-url', isPublication ? 'Page URL where the address was published' : 'Where consent was given (URL, optional if you add an excerpt)',
            <input id="au-ev-url" style={s.input} type="url" value={form.evidenceUrl} placeholder="https://" onChange={e => setForm(f => ({ ...f, evidenceUrl: e.target.value }))} />)}
          {field('au-ev-date', isPublication ? 'Date you saw it' : 'Date consent was given',
            <input id="au-ev-date" style={s.input} type="date" required max={new Date().toISOString().slice(0, 10)} value={form.evidenceAt} onChange={e => setForm(f => ({ ...f, evidenceAt: e.target.value }))} />)}
          {field('au-ev-excerpt', 'Excerpt (short quote, max 500 characters)',
            <textarea id="au-ev-excerpt" style={{ ...s.input, minHeight: 56 }} maxLength={500} value={form.evidenceExcerpt} onChange={e => setForm(f => ({ ...f, evidenceExcerpt: e.target.value }))} />)}
          {isPublication && (
            <>
              {field('au-ev-type', 'Address type', (
                <select id="au-ev-type" style={s.input} required value={form.addressType} onChange={e => setForm(f => ({ ...f, addressType: e.target.value }))}>
                  <option value="">— select —</option>
                  <option value="role">Role address (e.g. info@, sales@)</option>
                  <option value="personal">The person’s own address</option>
                </select>
              ))}
              <label style={{ display: 'flex', gap: 8, fontSize: 13, color: colors.text, marginBottom: 6 }}>
                <input type="checkbox" checked={form.optOutStatementAbsent} onChange={e => setForm(f => ({ ...f, optOutStatementAbsent: e.target.checked }))} />
                I checked: no “no unsolicited commercial email” (or similar) statement appears with the address
              </label>
              <label style={{ display: 'flex', gap: 8, fontSize: 13, color: colors.text, marginBottom: 10 }}>
                <input type="checkbox" checked={form.roleRelevant} onChange={e => setForm(f => ({ ...f, roleRelevant: e.target.checked }))} />
                My message is relevant to this person’s role or business
              </label>
            </>
          )}
          {formError && <div role="alert" style={{ color: colors.red, fontSize: 13, marginBottom: 8 }}>{formError}</div>}
          <button type="submit" style={s.btn} disabled={submitting}>{submitting ? <Spinner size={12} /> : 'Record evidence'}</button>
        </form>
      )}

      {/* Review */}
      <div style={{ fontWeight: 600, color: colors.text, fontSize: 13, margin: '16px 0 8px' }}>Consent records ({total})</div>
      {listError && <div role="alert" style={{ color: colors.red, fontSize: 13 }}>{listError}</div>}
      {records && records.length === 0 && <div style={{ color: colors.textFaint, fontSize: 12 }}>No consent records yet. Without a qualifying record, Australian sends are skipped.</div>}
      {records && records.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Consent records">
          {records.map(r => (
            <li key={r.id} style={s.cardInner}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span style={{ color: colors.text, fontSize: 13, wordBreak: 'break-all' }}>{r.email}</span>
                <Badge color={r.qualifiesForAustralia ? colors.greenDark : colors.redDark}>
                  {r.qualifiesForAustralia ? 'Qualifies for Australia' : 'Not sufficient for Australia'}
                </Badge>
              </div>
              <div style={{ color: colors.textMuted, fontSize: 12 }}>
                {BASIS_LABELS[r.basis] ?? r.basis} · recorded {fmtDate(r.recordedAt)}
                {r.evidenceAt ? ` · evidence dated ${fmtDate(r.evidenceAt)}` : ''}
                {r.addressType ? ` · ${r.addressType} address` : ''}
              </div>
              {r.evidenceUrl && <div style={{ color: colors.textFaint, fontSize: 12, wordBreak: 'break-all' }}>Source: {r.evidenceUrl}</div>}
              {r.evidenceExcerpt && <div style={{ color: colors.textFaint, fontSize: 12 }}>“{r.evidenceExcerpt}”</div>}
              {!r.qualifiesForAustralia && r.australiaReasons.length > 0 && (
                <ul style={{ margin: '4px 0 0 16px', padding: 0, color: colors.amber, fontSize: 12 }}>
                  {r.australiaReasons.map(x => <li key={x}>{x}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Readiness */}
      <div style={{ fontWeight: 600, color: colors.text, fontSize: 13, margin: '16px 0 8px' }}>Send readiness</div>
      {!readiness ? <div style={{ color: colors.textFaint, fontSize: 12 }}>Readiness unavailable right now.</div> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Send readiness">
          {readiness.checks.map(c => (
            <li key={c.name} style={{ fontSize: 13, color: c.ok ? colors.green : colors.amber, marginBottom: 4 }}>
              {c.ok ? '✓' : '✗'} {c.label}
              {!c.ok && c.hint ? <div style={{ color: colors.textFaint, fontSize: 12, marginLeft: 16 }}>{c.hint}</div> : null}
            </li>
          ))}
          <li style={{ fontSize: 13, color: readiness.ready ? colors.green : colors.amber, marginTop: 6, fontWeight: 600 }}>
            {readiness.ready ? 'Workspace is ready to send' : 'Not ready to send'}
          </li>
        </ul>
      )}
    </div>
  )
}

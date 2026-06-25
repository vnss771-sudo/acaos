import React, { useEffect, useMemo, useState } from 'react'
import { s, colors } from '../styles.js'
import { Spinner } from './Spinner.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import type { Workspace } from '../types.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

type Posture = {
  lawfulBasis: string | null
  liaAcknowledgedAt: string | null
  termsAcceptedAt: string | null
  termsVersion: string | null
  subprocessorsAckAt: string | null
  subprocessorsAckVersion: string | null
  targetsCanada: boolean
}
type Subprocessor = { name: string; purpose: string; data: string; conditional?: string }
type ComplianceData = {
  posture: Posture
  consentCount: number
  currentTermsVersion: string
  subprocessors: { version: string; subprocessors: Subprocessor[] }
}

const LAWFUL_BASIS_LABELS: Record<string, string> = {
  legitimate_interest: 'Legitimate interest (typical for cold B2B)',
  consent: 'Consent',
  contract: 'Contract / existing relationship',
}

// Settings → Compliance: attest GDPR lawful basis, accept terms, acknowledge the
// sub-processor list, and flag Canada targeting (CASL). Reporting/attestation only —
// the send gate stays dormant until COMPLIANCE_GATE_ENABLED is turned on server-side.
export function CompliancePanel({ api, workspace, toast, canManage = true }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [data, setData] = useState<ComplianceData | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState('')

  useEffect(() => {
    if (!workspace) return
    setLoading(true)
    api<ComplianceData>(`/api/workspaces/${workspace.id}/compliance`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workspace?.id])

  async function patch(body: Record<string, unknown>, label: string) {
    if (!workspace) return
    setSaving(label)
    try {
      const d = await route('PATCH /api/workspaces/:id/compliance', { params: { id: workspace.id }, body }) as { posture: Posture }
      setData(prev => prev ? { ...prev, posture: d.posture } : prev)
      toast.success('Compliance settings updated')
    } catch (e) {
      // A ReauthRequiredError is handled by the app-level reauth modal; other errors surface here.
      if (e instanceof Error && e.name !== 'ReauthRequiredError') toast.error(e.message)
    } finally { setSaving('') }
  }

  if (loading && !data) return <div style={s.card}><Spinner size={16} /> Loading compliance…</div>
  if (!data) return null
  const p = data.posture
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString() : null

  return (
    <div style={s.card}>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 4 }}>Compliance</div>
      <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 16 }}>
        Records your lawful basis and acceptances for cold-email compliance (GDPR / CAN-SPAM / CASL).
        ACAOS is your data processor — you remain the controller.
      </div>

      {/* Lawful basis */}
      <label style={{ display: 'block', color: colors.textMuted, fontSize: 13, marginBottom: 4 }}>GDPR lawful basis</label>
      <select
        style={{ ...s.input, marginBottom: 14 }}
        disabled={!canManage || saving === 'lawfulBasis'}
        value={p.lawfulBasis ?? ''}
        onChange={e => patch({ lawfulBasis: e.target.value || null }, 'lawfulBasis')}
      >
        <option value="">— not set —</option>
        {Object.entries(LAWFUL_BASIS_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>

      {/* Canada / CASL */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: colors.text, fontSize: 13 }}>
        <input
          type="checkbox"
          disabled={!canManage || saving === 'targetsCanada'}
          checked={p.targetsCanada}
          onChange={e => patch({ targetsCanada: e.target.checked }, 'targetsCanada')}
        />
        We send to Canadian recipients (requires a CASL consent basis per recipient)
      </label>

      {/* Acknowledgements */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <AckRow
          label="Acceptable-use & data-processing terms"
          done={fmt(p.termsAcceptedAt)}
          version={p.termsVersion}
          current={data.currentTermsVersion}
          busy={saving === 'acceptTerms'}
          disabled={!canManage}
          onClick={() => patch({ acceptTerms: true }, 'acceptTerms')}
        />
        <AckRow
          label="Sub-processor list reviewed"
          done={fmt(p.subprocessorsAckAt)}
          version={p.subprocessorsAckVersion}
          current={data.subprocessors.version}
          busy={saving === 'acknowledgeSubprocessors'}
          disabled={!canManage}
          onClick={() => patch({ acknowledgeSubprocessors: true }, 'acknowledgeSubprocessors')}
        />
        <AckRow
          label="Legitimate-interest assessment (LIA) on file"
          done={fmt(p.liaAcknowledgedAt)}
          busy={saving === 'acknowledgeLia'}
          disabled={!canManage}
          onClick={() => patch({ acknowledgeLia: true }, 'acknowledgeLia')}
        />
      </div>

      {/* Sub-processor disclosure */}
      <details>
        <summary style={{ cursor: 'pointer', color: colors.textMuted, fontSize: 13 }}>
          Sub-processors ({data.subprocessors.subprocessors.length}) · v{data.subprocessors.version}
        </summary>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.subprocessors.subprocessors.map(sp => (
            <div key={sp.name} style={{ fontSize: 12, color: colors.textMuted, borderLeft: `2px solid ${colors.border}`, paddingLeft: 8 }}>
              <span style={{ color: colors.text, fontWeight: 600 }}>{sp.name}</span> — {sp.purpose}. <em>{sp.data}.</em>
              {sp.conditional ? <span style={{ color: colors.textFaint }}> (only when {sp.conditional})</span> : null}
            </div>
          ))}
        </div>
      </details>

      <div style={{ marginTop: 12, color: colors.textFaint, fontSize: 12 }}>
        Consent records on file: {data.consentCount}
      </div>
    </div>
  )
}

function AckRow({ label, done, version, current, busy, disabled, onClick }: {
  label: string; done: string | null; version?: string | null; current?: string; busy: boolean; disabled: boolean; onClick: () => void
}) {
  const stale = done && version && current && version !== current
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <span style={{ color: colors.text, fontSize: 13 }}>
        {label}
        {done ? <span style={{ color: stale ? colors.amber : colors.green, fontSize: 11, marginLeft: 8 }}>
          {stale ? `accepted v${version} (update available)` : `✓ ${done}`}
        </span> : null}
      </span>
      {(!done || stale) && (
        <button style={s.btnSm} disabled={disabled || busy} onClick={onClick}>
          {busy ? <Spinner size={12} /> : (stale ? 'Re-accept' : 'Accept')}
        </button>
      )}
    </div>
  )
}

import React, { useCallback, useEffect, useState } from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

type AccessReviewRow = {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: string
  lastLoginAt: string | null
  mfaEnabled: boolean
}

type Props = {
  api: ApiHook
  workspaceId: string
  toast: ToastHook
}

function escCsvCell(v: unknown): string {
  const str = v == null ? '' : String(v)
  const needsQuote = str.includes(',') || str.includes('"') || str.includes('\n') || str.startsWith('=')
  return needsQuote ? `"${str.replace(/"/g, '""')}"` : str
}

function toCsv(rows: AccessReviewRow[]): string {
  const headers = ['email', 'name', 'role', 'joinedAt', 'lastLoginAt', 'mfaEnabled']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      escCsvCell(r.email), escCsvCell(r.name ?? ''), escCsvCell(r.role),
      escCsvCell(r.joinedAt), escCsvCell(r.lastLoginAt ?? ''), escCsvCell(r.mfaEnabled),
    ].join(','))
  }
  return lines.join('\n')
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString()
}

// SOC2 access review: who has access to this workspace, at what role, since
// when, when they last actually logged in, and whether MFA is on — the report
// an operator downloads periodically and files as evidence. Read-only; the
// data itself already exists via GET /api/workspaces/:id/access-review.
export function AccessReviewSection({ api, workspaceId, toast }: Props) {
  const [rows, setRows] = useState<AccessReviewRow[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api<{ members: AccessReviewRow[] }>(`/api/workspaces/${workspaceId}/access-review`)
      .then(d => setRows(d.members || []))
      .catch(() => toast.error('Failed to load access review'))
      .finally(() => setLoading(false))
  }, [api, workspaceId, toast])

  useEffect(() => { load() }, [load])

  function downloadCsv() {
    if (!rows) return
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `access-review-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const noMfaAdmins = (rows ?? []).filter(r => (r.role === 'owner' || r.role === 'admin') && !r.mfaEnabled)

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={s.sectionHeader}>Access Review</div>
        <button style={s.btnGhost} disabled={!rows || rows.length === 0} onClick={downloadCsv}>
          Download CSV
        </button>
      </div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 12 }}>
        Who has access to this workspace — for periodic offline review (SOC2 access
        review evidence).
      </div>

      {loading ? (
        <div style={{ padding: 16, textAlign: 'center' }}><Spinner /></div>
      ) : !rows || rows.length === 0 ? (
        <div style={{ color: colors.textFaint, fontSize: 13 }}>No members found.</div>
      ) : (
        <>
          {noMfaAdmins.length > 0 && (
            <div style={{
              background: colors.amber + '22', color: colors.amber, fontSize: 12,
              padding: '8px 12px', borderRadius: 6, marginBottom: 12,
            }}>
              {noMfaAdmins.length} owner/admin{noMfaAdmins.length === 1 ? '' : 's'} without MFA enabled.
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: colors.textFaint }}>
                  <th style={{ padding: '6px 8px' }}>Member</th>
                  <th style={{ padding: '6px 8px' }}>Role</th>
                  <th style={{ padding: '6px 8px' }}>Joined</th>
                  <th style={{ padding: '6px 8px' }}>Last login</th>
                  <th style={{ padding: '6px 8px' }}>MFA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.userId} style={{ borderTop: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '6px 8px', color: colors.text }}>
                      {r.name || r.email}
                      {r.name && <div style={{ color: colors.textFaint, fontSize: 11 }}>{r.email}</div>}
                    </td>
                    <td style={{ padding: '6px 8px', color: colors.textMuted }}>{r.role}</td>
                    <td style={{ padding: '6px 8px', color: colors.textMuted }}>{fmtDate(r.joinedAt)}</td>
                    <td style={{ padding: '6px 8px', color: colors.textMuted }}>{fmtDate(r.lastLoginAt)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: r.mfaEnabled ? colors.green : colors.textFaint }}>
                        {r.mfaEnabled ? 'Enabled' : 'Off'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

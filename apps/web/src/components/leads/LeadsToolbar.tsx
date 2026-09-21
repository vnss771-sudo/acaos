import React from 'react'
import { STAGES } from '../../types.js'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export function LeadsToolbar({
  stageFilter, onStageFilterChange,
  search, onSearchChange,
  skippedOnly, onToggleSkipped,
  total,
  canManage,
  selectedCount, bulkWorking, showBulkMenu, onToggleBulkMenu,
  onBulkResearch, onBulkDeleteRequest, onBulkStage,
  importing, fileRef, onImportClick, onImportCsv,
  hasWorkspace, onExportCsv,
  onAddClick,
}: {
  stageFilter: string; onStageFilterChange: (v: string) => void
  search: string; onSearchChange: (v: string) => void
  skippedOnly: boolean; onToggleSkipped: () => void
  total: number
  canManage: boolean
  selectedCount: number; bulkWorking: string | null; showBulkMenu: boolean; onToggleBulkMenu: () => void
  onBulkResearch: () => void; onBulkDeleteRequest: () => void; onBulkStage: (stage: string) => void
  importing: boolean; fileRef: React.RefObject<HTMLInputElement>; onImportClick: () => void
  onImportCsv: (e: React.ChangeEvent<HTMLInputElement>) => void
  hasWorkspace: boolean; onExportCsv: () => void
  onAddClick: () => void
}) {
  return (
    <div style={{ ...s.card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <select style={{ ...s.input, width: 160 }} value={stageFilter} onChange={e => onStageFilterChange(e.target.value)}>
        <option value="">All stages</option>
        {STAGES.map(st => <option key={st} value={st}>{st}</option>)}
      </select>

      <input
        style={{ ...s.input, width: 200 }}
        placeholder="Search leads…"
        value={search}
        onChange={e => onSearchChange(e.target.value)}
      />

      <button
        style={{ ...s.btnSm, background: skippedOnly ? colors.amber : '#1f2937', color: skippedOnly ? '#000' : colors.textMuted, fontWeight: skippedOnly ? 700 : 400 }}
        title="Show only poor-fit leads the outreach gate skipped"
        onClick={onToggleSkipped}
      >
        ⏭ Skipped
      </button>

      <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} leads</span>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {canManage && selectedCount > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              style={{ ...s.btnSm, background: '#1e3a5f', color: colors.blueLight }}
              onClick={onToggleBulkMenu}
              disabled={!!bulkWorking}
            >
              {bulkWorking ? <><Spinner size={12} /> Working…</> : `⚡ ${selectedCount} selected ▾`}
            </button>
            {showBulkMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: colors.bgElevated, border: `1px solid ${colors.border}`,
                borderRadius: 8, padding: 8, zIndex: 100, minWidth: 180,
                display: 'grid', gap: 2
              }}>
                <button style={{ ...s.btnSm, textAlign: 'left' }} onClick={onBulkResearch}>
                  ✦ Queue AI Research
                </button>
                <div style={{ borderTop: `1px solid ${colors.borderLight}`, margin: '4px 0' }} />
                <div style={{ color: colors.textFaint, fontSize: 11, padding: '4px 8px' }}>Move to stage</div>
                {['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'].map(st => (
                  <button key={st} style={{ ...s.btnSm, textAlign: 'left', fontSize: 12 }} onClick={() => onBulkStage(st)}>
                    → {st}
                  </button>
                ))}
                <div style={{ borderTop: `1px solid ${colors.borderLight}`, margin: '4px 0' }} />
                <button style={{ ...s.btnSm, textAlign: 'left', color: colors.red }} onClick={onBulkDeleteRequest}>
                  ✕ Delete selected
                </button>
              </div>
            )}
          </div>
        )}
        {canManage && (
          <button style={s.btnSm} onClick={onImportClick} disabled={importing}>
            {importing ? <><Spinner size={12} /> Importing…</> : '↑ Import CSV'}
          </button>
        )}
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onImportCsv} />
        {canManage && hasWorkspace && (
          <button style={s.btnSm} onClick={onExportCsv}>
            ↓ Export CSV
          </button>
        )}
        {canManage && <button style={s.btn} onClick={onAddClick}>+ Add Lead</button>}
      </div>
    </div>
  )
}

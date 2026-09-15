import React from 'react'
import type { Lead } from '../../types.js'
import { STAGE_COLOR } from '../../types.js'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Table, type Column, type SortState } from '../ui/Table.js'
import { ScorePill } from './ScorePill.js'

export function LeadsTable({
  leads, sortedLeads, loading, canManage,
  onRowClick,
  sort, onSortChange,
  selectedIds, onToggleRow, onToggleAll,
  onDeleteRequest, onAddClick, onDismissMenu,
  total, page, onPageChange, limit,
}: {
  leads: Lead[]; sortedLeads: Lead[]; loading: boolean; canManage: boolean
  onRowClick: (l: Lead) => void
  sort: SortState | undefined; onSortChange: (s: SortState | undefined) => void
  selectedIds: Set<string>; onToggleRow: (id: string) => void; onToggleAll: () => void
  onDeleteRequest: (l: Lead) => void; onAddClick: () => void; onDismissMenu: () => void
  total: number; page: number; onPageChange: (updater: (p: number) => number) => void; limit: number
}) {
  const columns: Column<Lead>[] = [
    {
      key: 'businessName', header: 'Business', sortable: true,
      render: l => (
        <span style={{ color: colors.text, fontSize: 14, fontWeight: 500 }}>
          {l.businessName}
          {l.outreachSkippedAt && <span style={{ ...s.badge(colors.amber), marginLeft: 6 }} title="Outreach skipped — poor fit">skipped</span>}
        </span>
      ),
    },
    { key: 'contactName', header: 'Contact', sortable: true, render: l => <span style={{ color: colors.textMuted, fontSize: 13 }}>{l.contactName || '–'}</span> },
    { key: 'email', header: 'Email', sortable: true, render: l => <span style={{ color: colors.textMuted, fontSize: 13 }}>{l.email || '–'}</span> },
    { key: 'category', header: 'Category', sortable: true, render: l => <span style={{ color: colors.textFaint, fontSize: 12 }}>{l.category || '–'}</span> },
    { key: 'stage', header: 'Stage', sortable: true, render: l => <span style={s.badge(STAGE_COLOR[l.stage] || colors.textFaint)}>{l.stage}</span> },
    { key: 'score', header: 'Score', sortable: true, render: l => <ScorePill score={l.score} /> },
    ...(canManage ? [{
      key: 'actions', header: '', render: (l: Lead) => (
        <div onClick={e => e.stopPropagation()}>
          <button style={s.btnDanger} aria-label={`Delete lead ${l.businessName}`} onClick={() => onDeleteRequest(l)}>✕</button>
        </div>
      ),
    } as Column<Lead>] : []),
  ]

  return (
    <div style={s.card} onClick={onDismissMenu}>
      {loading && leads.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32 }}><Spinner /></div>
      ) : leads.length === 0 ? (
        <EmptyState
          title="No leads found"
          description="Add your first lead or import a CSV."
          action={canManage ? <button style={s.btn} onClick={onAddClick}>+ Add Lead</button> : undefined}
        />
      ) : (
        <Table<Lead>
          columns={columns}
          rows={sortedLeads}
          rowKey={l => l.id}
          onRowClick={l => onRowClick(l)}
          sort={sort}
          onSortChange={onSortChange}
          {...(canManage ? { selectedKeys: selectedIds, onToggleRow: (id: string) => onToggleRow(id), onToggleAll } : {})}
        />
      )}

      {total > limit && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
          <button style={s.btnSm} disabled={page === 1} onClick={() => onPageChange(p => p - 1)}>← Prev</button>
          <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(total / limit)}</span>
          <button style={s.btnSm} disabled={leads.length < limit} onClick={() => onPageChange(p => p + 1)}>Next →</button>
        </div>
      )}
    </div>
  )
}

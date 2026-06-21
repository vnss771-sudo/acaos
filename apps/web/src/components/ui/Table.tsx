import React, { useState } from 'react'
import { colors } from '../../styles.js'

export type Column<T> = {
  key: string
  header: string
  align?: 'left' | 'right' | 'center'
  /** Cell renderer; defaults to String((row as any)[key]). */
  render?: (row: T) => React.ReactNode
  sortable?: boolean
}

export type SortState = { key: string; dir: 'asc' | 'desc' }

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Controlled sort indicator + handler (sorting itself is done by the caller). */
  sort?: SortState
  onSortChange?: (next: SortState) => void
  empty?: React.ReactNode
  /**
   * Multi-select support. When both `selectedKeys` and `onToggleRow` are passed,
   * a leading checkbox column is rendered (with a header select-all driven by
   * `onToggleAll`). Checkbox clicks are isolated from `onRowClick`.
   */
  selectedKeys?: Set<string>
  onToggleRow?: (key: string, row: T) => void
  onToggleAll?: () => void
}

const thBase: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: colors.textFaint,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: 'nowrap',
}

const tdBase: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 13,
  color: colors.text,
  borderBottom: `1px solid ${colors.borderLight}`,
}

// Generic data table. Wrapped in an overflow-x container so it scrolls instead of
// breaking layout on narrow screens (the zero-risk responsive default). Sorting is
// controlled by the caller via `sort`/`onSortChange`. Optional multi-select adds a
// leading checkbox column (see `selectedKeys`/`onToggleRow`/`onToggleAll`).
export function Table<T>({ columns, rows, rowKey, onRowClick, sort, onSortChange, empty, selectedKeys, onToggleRow, onToggleAll }: Props<T>) {
  const selectable = !!selectedKeys && !!onToggleRow
  const allSelected = selectable && rows.length > 0 && rows.every(r => selectedKeys!.has(rowKey(r)))
  const totalCols = columns.length + (selectable ? 1 : 0)
  // Inline styles can't carry :hover; clickable rows highlight via React state
  // (same approach as the Dashboard quick-action buttons). Only the hovered row
  // is tracked, and only when rows are clickable.
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  const toggleSort = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return
    const dir: 'asc' | 'desc' = sort?.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc'
    onSortChange({ key: col.key, dir })
  }

  return (
    <div style={{ overflowX: 'auto', width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ ...thBase, width: 36, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onToggleAll?.()}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map(col => {
              const active = sort?.key === col.key
              return (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col)}
                  style={{
                    ...thBase,
                    textAlign: col.align ?? 'left',
                    cursor: col.sortable && onSortChange ? 'pointer' : 'default',
                    color: active ? colors.text : thBase.color,
                  }}
                >
                  {col.header}
                  {col.sortable && active ? (sort!.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={totalCols} style={{ ...tdBase, textAlign: 'center', color: colors.textFaint, padding: '32px 12px' }}>
                {empty ?? 'No data'}
              </td>
            </tr>
          ) : (
            rows.map(row => {
              const key = rowKey(row)
              return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onMouseEnter={onRowClick ? () => setHoverKey(key) : undefined}
                onMouseLeave={onRowClick ? () => setHoverKey(null) : undefined}
                style={{
                  cursor: onRowClick ? 'pointer' : 'default',
                  background: onRowClick && hoverKey === key ? colors.bgSurface : 'transparent',
                  transition: onRowClick ? 'background 0.15s' : undefined,
                }}
              >
                {selectable && (
                  <td style={{ ...tdBase, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedKeys!.has(key)}
                      onChange={() => onToggleRow!(key, row)}
                      aria-label={`Select row ${key}`}
                    />
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key} style={{ ...tdBase, textAlign: col.align ?? 'left' }}>
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

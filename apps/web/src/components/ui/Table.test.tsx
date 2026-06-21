import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Table, type Column } from './Table.js'

type Row = { id: string; name: string; score: number }
const rows: Row[] = [
  { id: '1', name: 'Acme', score: 88 },
  { id: '2', name: 'Globex', score: 73 },
]
const columns: Column<Row>[] = [
  { key: 'name', header: 'Company' },
  { key: 'score', header: 'Score', align: 'right', sortable: true },
]

describe('Table', () => {
  test('renders headers and cells', () => {
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} />)
    expect(screen.getByText('Company')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('88')).toBeInTheDocument()
  })

  test('fires onRowClick', () => {
    const onRowClick = vi.fn()
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} onRowClick={onRowClick} />)
    fireEvent.click(screen.getByText('Globex'))
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  test('renders the empty state when there are no rows', () => {
    render(<Table columns={columns} rows={[]} rowKey={r => r.id} empty="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
  })

  test('clicking a sortable header requests a sort', () => {
    const onSortChange = vi.fn()
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} onSortChange={onSortChange} />)
    fireEvent.click(screen.getByText('Score'))
    expect(onSortChange).toHaveBeenCalledWith({ key: 'score', dir: 'asc' })
  })
})

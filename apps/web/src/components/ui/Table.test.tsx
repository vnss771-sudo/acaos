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

  test('hovering a clickable row highlights it and still fires onRowClick', () => {
    const onRowClick = vi.fn()
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} onRowClick={onRowClick} />)
    const cell = screen.getByText('Acme')
    const row = cell.closest('tr') as HTMLTableRowElement
    fireEvent.mouseEnter(row)
    expect(row.style.background).not.toBe('transparent')
    fireEvent.mouseLeave(row)
    expect(row.style.background).toBe('transparent')
    fireEvent.click(cell)
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
  })

  test('rows without onRowClick are not highlighted on hover', () => {
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} />)
    const row = screen.getByText('Acme').closest('tr') as HTMLTableRowElement
    fireEvent.mouseEnter(row)
    expect(row.style.background).toBe('transparent')
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

  test('renders a select-all checkbox and per-row checkboxes when selectable', () => {
    render(
      <Table columns={columns} rows={rows} rowKey={r => r.id} selectedKeys={new Set()} onToggleRow={vi.fn()} onToggleAll={vi.fn()} />,
    )
    expect(screen.getByLabelText('Select all rows')).toBeInTheDocument()
    expect(screen.getByLabelText('Select row 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Select row 2')).toBeInTheDocument()
  })

  test('ticking a row checkbox calls onToggleRow without firing onRowClick', () => {
    const onToggleRow = vi.fn()
    const onRowClick = vi.fn()
    render(
      <Table columns={columns} rows={rows} rowKey={r => r.id} onRowClick={onRowClick} selectedKeys={new Set()} onToggleRow={onToggleRow} />,
    )
    fireEvent.click(screen.getByLabelText('Select row 1'))
    expect(onToggleRow).toHaveBeenCalledWith('1', rows[0])
    expect(onRowClick).not.toHaveBeenCalled()
  })

  test('select-all is checked only when every row is selected', () => {
    const { rerender } = render(
      <Table columns={columns} rows={rows} rowKey={r => r.id} selectedKeys={new Set(['1'])} onToggleRow={vi.fn()} />,
    )
    expect(screen.getByLabelText('Select all rows')).not.toBeChecked()
    rerender(
      <Table columns={columns} rows={rows} rowKey={r => r.id} selectedKeys={new Set(['1', '2'])} onToggleRow={vi.fn()} />,
    )
    expect(screen.getByLabelText('Select all rows')).toBeChecked()
  })
})

// UQ-21: opt-in phone layout.
describe('Table mobileCards', () => {
  const phone = () => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
  const withAction: Column<Row>[] = [...columns, { key: 'actions', header: '', render: r => <button>Edit {r.name}</button> }]

  test('at phone width renders one card per row, not a table', () => {
    phone()
    render(<Table columns={withAction} rows={rows} rowKey={r => r.id} mobileCards />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByText('Score')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Edit Acme' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  test('keeps the table on desktop, and on phones when not opted in', () => {
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} mobileCards />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    phone()
    render(<Table columns={columns} rows={rows} rowKey={r => r.id} />)
    expect(screen.getAllByRole('table')).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  test('shows the empty state in card mode', () => {
    phone()
    render(<Table columns={columns} rows={[]} rowKey={r => r.id} mobileCards empty="No shifts" />)
    expect(screen.getByText('No shifts')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})

import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KpiCard } from './KpiCard.js'

describe('KpiCard', () => {
  test('renders label, value and sub', () => {
    render(<KpiCard label="Total Leads" value={142} sub="+12 this week" />)
    expect(screen.getByText('Total Leads')).toBeInTheDocument()
    expect(screen.getByText('142')).toBeInTheDocument()
    expect(screen.getByText('+12 this week')).toBeInTheDocument()
  })

  test('renders 0 rather than a blank tile when value is undefined or null', () => {
    const { rerender } = render(<KpiCard label="Open Alerts" value={undefined} />)
    expect(screen.getByText('0')).toBeInTheDocument()
    rerender(<KpiCard label="Open Alerts" value={null} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })
})

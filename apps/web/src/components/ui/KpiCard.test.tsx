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
})

import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from './Badge.js'

describe('Badge', () => {
  test('renders text with the given background color', () => {
    render(<Badge color="#ff0000">HOT</Badge>)
    const el = screen.getByText('HOT')
    expect(el).toBeInTheDocument()
    expect(el).toHaveStyle({ background: '#ff0000' })
  })
})

import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SkipLink } from './SkipLink.js'

describe('SkipLink', () => {
  test('renders a link that targets the main content landmark', () => {
    render(<SkipLink />)
    const link = screen.getByRole('link', { name: /skip to main content/i })
    expect(link).toHaveAttribute('href', '#main-content')
  })
})

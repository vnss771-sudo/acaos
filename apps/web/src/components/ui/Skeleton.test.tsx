import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Skeleton } from './Skeleton.js'

describe('Skeleton', () => {
  test('renders a busy status placeholder with given dimensions', () => {
    render(<Skeleton width={120} height={20} />)
    const el = screen.getByRole('status')
    expect(el).toHaveAttribute('aria-busy', 'true')
    expect(el).toHaveStyle({ width: '120px', height: '20px' })
  })
})

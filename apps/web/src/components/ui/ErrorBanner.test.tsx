import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBanner } from './ErrorBanner.js'

describe('ErrorBanner', () => {
  test('renders a default message and an alert role', () => {
    render(<ErrorBanner onRetry={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load. Please try again.')
  })

  test('renders a custom message when given one', () => {
    render(<ErrorBanner message="Failed to load leads." onRetry={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load leads.')
  })

  test('clicking Retry calls onRetry', () => {
    const onRetry = vi.fn()
    render(<ErrorBanner onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

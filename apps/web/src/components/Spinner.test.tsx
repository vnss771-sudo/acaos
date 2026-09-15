import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Spinner } from './Spinner.js'

describe('Spinner', () => {
  test('Spinner renders an svg sized by the prop', () => {
    const { container } = render(<Spinner size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('width', '32')
  })

  test('Spinner exposes an accessible status role and label', () => {
    render(<Spinner />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', 'Loading')
  })

  test('Spinner label is customizable', () => {
    render(<Spinner label="Saving" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Saving')
  })

})

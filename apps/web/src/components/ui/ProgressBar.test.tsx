import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProgressBar } from './ProgressBar.js'

describe('ProgressBar', () => {
  test('exposes progressbar role with aria values', () => {
    render(<ProgressBar value={25} max={100} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  test('clamps the fill width to 100% when value exceeds max', () => {
    render(<ProgressBar value={500} max={100} />)
    const fill = screen.getByRole('progressbar').firstChild as HTMLElement
    expect(fill.style.width).toBe('100%')
  })
})

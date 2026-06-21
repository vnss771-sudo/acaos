import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Grid } from './Grid.js'

describe('Grid', () => {
  test('renders children in a grid (desktop column count under jsdom)', () => {
    render(
      <Grid cols={3}>
        <div>a</div>
        <div>b</div>
        <div>c</div>
      </Grid>,
    )
    expect(screen.getByText('a')).toBeInTheDocument()
    // matchMedia is stubbed to false in test setup → desktop columns.
    const grid = screen.getByText('a').parentElement as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, 1fr)')
  })
})

import { describe, test, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useMediaQuery } from './useMediaQuery.js'

function Probe({ query }: { query: string }) {
  const match = useMediaQuery(query)
  return <div>{match ? 'match' : 'no-match'}</div>
}

describe('useMediaQuery', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('returns false when matchMedia reports no match (jsdom default)', () => {
    render(<Probe query="(max-width: 640px)" />)
    expect(screen.getByText('no-match')).toBeInTheDocument()
  })

  test('returns true when matchMedia reports a match', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    render(<Probe query="(max-width: 640px)" />)
    expect(screen.getByText('match')).toBeInTheDocument()
  })
})

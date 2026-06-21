import { useEffect, useState } from 'react'
import { tokens } from '../styles.js'

// Subscribe to a CSS media query. Returns false in any environment without
// matchMedia (SSR, or jsdom unless stubbed — see src/test/setup.ts), so callers
// default to the desktop layout. Lets the inline-style world react to viewport
// width without a CSS pipeline.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** True at phone widths (<= tokens.breakpoint.mobile). */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${tokens.breakpoint.mobile}px)`)
}

/** True at tablet-and-below widths (<= tokens.breakpoint.tablet). */
export function useIsTablet(): boolean {
  return useMediaQuery(`(max-width: ${tokens.breakpoint.tablet}px)`)
}

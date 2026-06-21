import React from 'react'
import { useIsMobile, useIsTablet } from '../../hooks/useMediaQuery.js'

type Props = {
  cols: 2 | 3 | 4
  gap?: number
  children: React.ReactNode
  style?: React.CSSProperties
}

// Responsive replacement for the fixed `s.grid2/3/4` / inline `repeat(n,1fr)`
// grids. Collapses to a single column on phones and caps at two columns on
// tablets; full `cols` on desktop. Under jsdom (matchMedia stubbed false) it
// renders the desktop column count, so existing tests are unaffected.
export function Grid({ cols, gap = 16, children, style }: Props) {
  const isMobile = useIsMobile()
  const isTablet = useIsTablet()
  let effective: number = cols
  if (isTablet && cols > 2) effective = 2
  if (isMobile) effective = 1
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${effective}, 1fr)`, gap, ...style }}>
      {children}
    </div>
  )
}

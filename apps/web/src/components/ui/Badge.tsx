import React from 'react'
import { s } from '../../styles.js'

type Props = {
  /** Background color (e.g. a tier/status color from `colors`). */
  color: string
  children: React.ReactNode
  style?: React.CSSProperties
}

// Pill/badge primitive over the existing `s.badge(color)` style, so tier/status
// chips render consistently across views.
export function Badge({ color, children, style }: Props) {
  return <span style={{ ...s.badge(color), ...style }}>{children}</span>
}

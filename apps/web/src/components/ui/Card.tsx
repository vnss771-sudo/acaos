import React from 'react'
import { s } from '../../styles.js'

type Props = {
  children: React.ReactNode
  /** Use the darker, tighter inner-card treatment. */
  inner?: boolean
  onClick?: () => void
  style?: React.CSSProperties
  className?: string
}

// Surface primitive over the existing `s.card` / `s.cardInner` tokens so every
// view stops re-declaring the same border/radius/padding inline.
export function Card({ children, inner, onClick, style, className }: Props) {
  const base = inner ? s.cardInner : s.card
  return (
    <div
      className={className}
      onClick={onClick}
      style={{ ...base, ...(onClick ? { cursor: 'pointer' } : null), ...style }}
    >
      {children}
    </div>
  )
}

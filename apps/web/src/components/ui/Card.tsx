import React, { useState } from 'react'
import { s, colors } from '../../styles.js'

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
  // Inline styles can't carry :hover, so clickable cards track hover via React
  // state (same approach as the Dashboard quick-action buttons). Non-clickable
  // cards keep their original styling and behaviour unchanged.
  const [hover, setHover] = useState(false)
  const interactive = !!onClick
  const hoverStyle: React.CSSProperties =
    interactive && hover ? { borderColor: colors.blue, background: colors.bgElevated } : {}
  return (
    <div
      className={className}
      onClick={onClick}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        ...base,
        ...(interactive ? { cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' } : null),
        ...style,
        ...hoverStyle,
      }}
    >
      {children}
    </div>
  )
}

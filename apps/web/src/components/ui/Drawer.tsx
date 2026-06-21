import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey.js'
import { colors } from '../../styles.js'

type Props = {
  open: boolean
  onClose: () => void
  side?: 'left' | 'right'
  width?: number
  children: React.ReactNode
}

// Slide-in side panel over a scrim. Primary use: the responsive app shell renders
// the sidebar inside a left Drawer at tablet/mobile widths. Same close semantics
// as Modal (click-outside + Escape).
export function Drawer({ open, onClose, side = 'left', width = 248, children }: Props) {
  useEscapeKey(onClose, open)
  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: side === 'left' ? 'flex-start' : 'flex-end' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
        style={{ background: colors.bgSurface, borderRight: side === 'left' ? `1px solid ${colors.border}` : undefined, borderLeft: side === 'right' ? `1px solid ${colors.border}` : undefined, width, maxWidth: '85vw', height: '100%', overflowY: 'auto' }}
      >
        {children}
      </div>
    </div>
  )
}

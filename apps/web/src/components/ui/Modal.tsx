import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey.js'
import { colors } from '../../styles.js'

type Props = {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}

// Centered modal dialog. Mirrors the overlay/z-index/aria conventions of the
// existing one-off modals (LaunchApprovalModal, ReauthModal): fixed full-screen
// scrim, click-outside + Escape to close, role="dialog" aria-modal.
export function Modal({ open, onClose, title, children, footer, width = 480 }: Props) {
  useEscapeKey(onClose, open)
  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, width, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto' }}
      >
        {title && <div style={{ fontSize: 18, fontWeight: 700, color: colors.text, marginBottom: 16 }}>{title}</div>}
        {children}
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>{footer}</div>}
      </div>
    </div>
  )
}

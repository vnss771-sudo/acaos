import React from 'react'
import type { Toast } from '../hooks/useToast.js'

const TOAST_COLORS = {
  success: { bg: '#14532d', border: '#16a34a', icon: '✓' },
  error: { bg: '#450a0a', border: '#ef4444', icon: '✕' },
  warning: { bg: '#451a03', border: '#f59e0b', icon: '⚠' },
  info: { bg: '#0c1a2e', border: '#3b82f6', icon: 'ℹ' }
}

export function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      zIndex: 9999,
      maxWidth: 380,
      width: '100%'
    }}>
      {toasts.map(t => {
        const c = TOAST_COLORS[t.type]
        return (
          <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} style={{
            background: c.bg,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            animation: 'slideIn 0.2s ease'
          }}>
            <span aria-hidden="true" style={{ color: c.border, fontSize: 14, marginTop: 1, flexShrink: 0 }}>{c.icon}</span>
            <span style={{ color: '#e2e8f0', fontSize: 14, flex: 1, lineHeight: 1.4 }}>{t.message}</span>
            <button
              onClick={() => onRemove(t.id)}
              aria-label="Dismiss notification"
              style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1, flexShrink: 0 }}
            >
              ×
            </button>
          </div>
        )
      })}
      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </div>
  )
}

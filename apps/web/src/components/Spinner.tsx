import React from 'react'

export function Spinner({ size = 20, color = '#3b82f6', label = 'Loading' }: { size?: number; color?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" style={{ animation: 'spin 0.8s linear infinite' }}>
        <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity="0.25" strokeWidth="3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
      </svg>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  )
}

export function LoadingRow({ cols = 1 }: { cols?: number }) {
  return (
    <tr>
      <td colSpan={cols} style={{ padding: '32px 16px', textAlign: 'center', color: '#475569' }}>
        <Spinner /> Loading…
      </td>
    </tr>
  )
}

export function EmptyState({ message, icon = '◎' }: { message: string; icon?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', color: '#475569' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 14 }}>{message}</div>
    </div>
  )
}

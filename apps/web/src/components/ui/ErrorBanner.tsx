import React from 'react'
import { colors, s } from '../../styles.js'

type Props = {
  message?: string
  onRetry: () => void
}

// Persistent "couldn't load" state, distinct from EmptyState ("loaded fine,
// there's just nothing here"). A failed fetch already fires a toast, but that
// auto-dismisses — without this, the page then renders identically to a
// genuinely-empty result. Shown alongside EmptyState/Skeleton, not replacing
// either.
export function ErrorBanner({ message = 'Failed to load. Please try again.', onRetry }: Props) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        padding: '14px 18px', borderRadius: 10,
        background: 'rgba(239, 68, 68, 0.08)', border: `1px solid ${colors.red}`,
      }}
    >
      <span style={{ color: colors.text, fontSize: 14 }}>{message}</span>
      <button style={s.btnSecondary} onClick={onRetry}>Retry</button>
    </div>
  )
}

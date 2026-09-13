import React from 'react'
import { colors } from '../../styles.js'

type Props = {
  title: string
  description?: string
  action?: React.ReactNode
}

// Empty-list placeholder: a title, an optional explanation, and an optional
// action (e.g. "Add crew member"). Used in place of a bare "No X found" string
// so an empty table reads as a starting point, not a dead end.
export function EmptyState({ title, description, action }: Props) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px' }}>
      <div style={{ color: colors.text, fontSize: 15, fontWeight: 600, marginBottom: description ? 6 : 0 }}>{title}</div>
      {description && <div style={{ color: colors.textMuted, fontSize: 13, maxWidth: 420, margin: '0 auto' }}>{description}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

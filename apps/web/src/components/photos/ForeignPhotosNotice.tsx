import React from 'react'
import { colors } from '../../styles.js'
import { formatBytes } from '../../lib/evidence/persistence.js'
import { usePhotoUploads } from './PhotoUploadProvider.js'

// Shown when a previous person left unsent photos on this phone. Says only that they exist; they cannot be
// opened, listed, uploaded or deleted from this account (that person finishes or removes them by signing in again).
export function ForeignPhotosNotice() {
  const p = usePhotoUploads()
  if (!p?.foreign) return null
  const { count, bytes } = p.foreign
  return (
    <div role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#1f2937', borderBottom: `1px solid ${colors.border}`, color: colors.text, fontSize: 14 }}>
      <span style={{ flex: '1 1 240px' }}>
        This phone is holding {count} unsent photo{count === 1 ? '' : 's'} ({formatBytes(bytes)}) from a different account. They can't be opened, uploaded or deleted from this account. Sign in with that account to finish or remove them.
      </span>
    </div>
  )
}

import React from 'react'
import { colors } from '../../styles.js'
import { formatBytes } from '../../lib/evidence/persistence.js'
import { usePhotoUploads } from './PhotoUploadProvider.js'

// Shown when a previous person left unsent photos on this phone. Says only that they exist; they cannot be
// opened, listed or uploaded from this account, and are deleted only if this person chooses to.
export function ForeignPhotosNotice() {
  const p = usePhotoUploads()
  if (!p?.foreign) return null
  const { count, bytes } = p.foreign
  return (
    <div role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#1f2937', borderBottom: `1px solid ${colors.border}`, color: colors.text, fontSize: 14 }}>
      <span style={{ flex: '1 1 240px' }}>
        This phone is holding {count} unsent photo{count === 1 ? '' : 's'} ({formatBytes(bytes)}) from a different account. They can't be opened or uploaded from this account.
      </span>
      <button type="button" onClick={p.confirmDeleteForeign}
        style={{ minHeight: 44, minWidth: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, cursor: 'pointer', fontSize: 14 }}>
        Delete them…
      </button>
    </div>
  )
}

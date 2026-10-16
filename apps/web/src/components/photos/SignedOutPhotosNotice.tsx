import React, { useEffect, useMemo, useState } from 'react'
import { colors } from '../../styles.js'
import { IndexedDbQueueStore, type QueueStore } from '../../lib/evidence/queueStore.js'

// Shown on the sign-in screen when this phone may hold unsent photos. Deliberately generic: no count, no size,
// no account or workspace hint, because anyone can open the sign-in screen. It reads only "is the queue
// non-empty" and shows nothing if local storage is unavailable.
export const SIGNED_OUT_PHOTOS_TEXT = 'Photos saved on this phone are waiting to upload. Sign in with the account that took them.'

export function SignedOutPhotosNotice({ store: storeProp }: { store?: QueueStore }) {
  const store = useMemo<QueueStore | null>(() => {
    if (storeProp) return storeProp
    try { return typeof indexedDB !== 'undefined' ? new IndexedDbQueueStore() : null } catch { return null }
  }, [storeProp])
  const [any, setAny] = useState(false)
  useEffect(() => {
    if (!store) return
    let cancelled = false
    void store.summary().then((rows) => { if (!cancelled) setAny(rows.some((r) => r.count > 0)) }).catch(() => {})
    return () => { cancelled = true }
  }, [store])
  if (!any) return null
  return (
    <div role="status" data-testid="photos-signed-out-notice" style={{ padding: '10px 16px', minHeight: 44, boxSizing: 'border-box', background: '#1e293b', borderBottom: `1px solid ${colors.border}`, color: colors.text, fontSize: 14, textAlign: 'center' }}>
      {SIGNED_OUT_PHOTOS_TEXT}
    </div>
  )
}

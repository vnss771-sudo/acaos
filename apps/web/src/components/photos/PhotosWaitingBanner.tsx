import React from 'react'
import { colors } from '../../styles.js'
import { usePhotoUploads } from './PhotoUploadProvider.js'

// Signed in: says how many of THIS user's photos are saved on the phone and not yet sent, across their workspaces.
// Informational only: no upload button (uploads start by themselves), no delete action, no job list. It does not
// need the job list to load, so it still shows when the app is reopened with no connection. Counts only this
// account's photos; another account's photos are reported separately by ForeignPhotosNotice.
export function PhotosWaitingBanner() {
  const p = usePhotoUploads()
  const own = p?.own
  if (!p || !own || own.count < 1) return null
  const n = own.count
  const photos = `${n} photo${n === 1 ? '' : 's'}`
  const state = own.attention > 0
    ? `${own.attention} need${own.attention === 1 ? 's' : ''} attention. Open the job's Photos tab to retry or review.`
    : !p.snapshot.online ? 'Waiting for a connection. They will upload when you are back online.'
    : own.active > 0 ? 'Uploading now.'
    : 'Waiting to upload.'
  return (
    <div role="status" data-testid="photos-waiting-banner" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '10px 16px', minHeight: 44, boxSizing: 'border-box', background: '#1e293b', borderBottom: `1px solid ${colors.border}`, color: colors.text, fontSize: 14, overflowWrap: 'anywhere' }}>
      <strong style={{ fontWeight: 600 }}>{photos} saved on this phone {n === 1 ? 'is' : 'are'} waiting to upload.</strong>{' '}
      <span>{state}</span>
      {own.elsewhere > 0 && <span> {own.elsewhere === n ? 'They are' : `${own.elsewhere} of them ${own.elsewhere === 1 ? 'is' : 'are'}`} in another workspace and upload when you switch back.</span>}
    </div>
  )
}

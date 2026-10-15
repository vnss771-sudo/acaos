import React from 'react'
import { Modal } from '../ui/Modal.js'
import { colors } from '../../styles.js'
import { formatBytes } from '../../lib/evidence/persistence.js'

export type DialogKind = 'logout' | 'switch' | 'cleanup_failed'
export type DialogView = { kind: DialogKind; count: number; bytes: number; workspaceName?: string }

const btn: React.CSSProperties = { minHeight: 48, minWidth: 48, padding: '0 16px', fontSize: 16, borderRadius: 10, cursor: 'pointer', boxSizing: 'border-box' }
const safe: React.CSSProperties = { ...btn, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text }
const danger: React.CSSProperties = { ...btn, border: 'none', background: colors.red, color: '#fff', fontWeight: 600 }
const proceed: React.CSSProperties = { ...btn, border: 'none', background: colors.blue, color: '#fff', fontWeight: 600 }

const photos = (n: number) => `${n} photo${n === 1 ? '' : 's'}`

// Confirmation before anything that could lose, or strand, photos that have not reached the server.
// The safe choice is first, focused by default, and what Escape and the backdrop do.
export function UnsentPhotosDialog({ state, onCancel, onConfirm }: { state: DialogView | null; onCancel: () => void; onConfirm: () => void }) {
  if (!state) return null
  const { kind, count, bytes, workspaceName } = state
  const size = formatBytes(bytes)
  const copy = {
    logout: {
      title: 'Photos have not finished uploading',
      body: `${photos(count)} (${size}) on this phone ${count === 1 ? 'has' : 'have'} not been uploaded yet. If you sign out now ${count === 1 ? 'it' : 'they'} will be deleted from this phone and cannot be recovered. Stay signed in to let ${count === 1 ? 'it' : 'them'} finish, ideally with a good connection.`,
      cancel: 'Stay signed in', confirm: 'Sign out and delete photos', style: danger,
    },
    switch: {
      title: 'Photos are still waiting',
      body: `${photos(count)} (${size}) in ${workspaceName ?? 'this workspace'} ${count === 1 ? 'has' : 'have'} not finished uploading. ${count === 1 ? 'It stays' : 'They stay'} on this phone and ${count === 1 ? 'uploads' : 'upload'} when you switch back, but nothing is sent while you are in another workspace, and the browser can delete stored photos if the phone runs low on space.`,
      cancel: 'Stay here', confirm: 'Switch workspace', style: proceed,
    },
    cleanup_failed: {
      title: 'Photos may still be on this phone',
      body: count > 0
        ? `We could not delete ${photos(count)} (${size}) from this phone. If you sign out now, ${count === 1 ? 'it' : 'they'} may stay on this phone, and anyone who uses this browser profile could still be holding ${count === 1 ? 'it' : 'them'}. You can still sign out. Staying signed in lets ${count === 1 ? 'it' : 'them'} finish uploading.`
        : 'We could not check which photos are stored on this phone, so we cannot tell you that none are left. If you sign out now, any unsent photos may stay on this phone. You can still sign out.',
      cancel: 'Stay signed in', confirm: 'Sign out anyway', style: proceed,
    },
  }[kind]
  return (
    <Modal open onClose={onCancel} title={copy.title} width={440}
      footer={(
        <>
          <button type="button" style={safe} onClick={onCancel} autoFocus>{copy.cancel}</button>
          <button type="button" style={copy.style} onClick={onConfirm}>{copy.confirm}</button>
        </>
      )}>
      <p style={{ margin: 0, color: colors.text, fontSize: 15, lineHeight: 1.5 }}>{copy.body}</p>
    </Modal>
  )
}

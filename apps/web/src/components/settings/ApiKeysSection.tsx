import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import { Modal } from '../ui/Modal.js'

export function ApiKeysSection({
  hasKey, keyWorking, onGenerate, onRevokeRequest,
  revokeKeyConfirmOpen, onCloseRevokeModal, onConfirmRevoke,
  newKeyModal, keyCopied, onCopyKey, onCloseKeyModal,
}: {
  hasKey: boolean
  keyWorking: boolean
  onGenerate: () => void
  onRevokeRequest: () => void
  revokeKeyConfirmOpen: boolean
  onCloseRevokeModal: () => void
  onConfirmRevoke: () => void
  newKeyModal: string | null
  keyCopied: boolean
  onCopyKey: (key: string) => void
  onCloseKeyModal: () => void
}) {
  return (
    <div style={s.card}>
      {/* API Key modal */}
      {newKeyModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200
        }}>
          <div role="dialog" aria-modal="true" aria-label="New API key" style={{ ...s.card, maxWidth: 480, width: '90%' }}>
            <div style={{ color: colors.amber, fontWeight: 700, marginBottom: 8 }}>⚠ Save this key — it will not be shown again</div>
            <div style={{
              background: '#0b1220', border: `1px solid ${colors.border}`,
              borderRadius: 6, padding: '10px 14px', fontFamily: 'monospace',
              fontSize: 13, color: colors.text, wordBreak: 'break-all', marginBottom: 12
            }}>
              {newKeyModal}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btn} onClick={() => onCopyKey(newKeyModal)}>
                {keyCopied ? '✓ Copied' : 'Copy Key'}
              </button>
              <button style={s.btnGhost} onClick={onCloseKeyModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={s.sectionHeader}>API Keys</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: colors.textMuted, fontSize: 13 }}>Ingest API Key</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: hasKey ? colors.green : colors.textFaint, display: 'inline-block' }} />
            <span style={{ color: hasKey ? colors.green : colors.textFaint, fontSize: 13 }}>
              {hasKey ? 'Key configured' : 'No key'}
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={s.btn} disabled={keyWorking} onClick={onGenerate}>
          {keyWorking ? <><Spinner size={14} color="#fff" /> Working…</> : 'Generate New Key'}
        </button>
        {hasKey && (
          <button style={{ ...s.btnGhost, color: colors.red }} disabled={keyWorking} onClick={onRevokeRequest}>
            Revoke Key
          </button>
        )}
      </div>

      <Modal
        open={revokeKeyConfirmOpen}
        onClose={onCloseRevokeModal}
        title="Revoke API key?"
        footer={<>
          <button style={s.btnSecondary} onClick={onCloseRevokeModal}>Cancel</button>
          <button style={s.btnDanger} disabled={keyWorking} onClick={onConfirmRevoke}>{keyWorking ? 'Revoking…' : 'Revoke'}</button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14 }}>
          All integrations using this key will stop working immediately.
        </div>
      </Modal>
    </div>
  )
}

import React from 'react'
import type { WorkspaceMember } from '../../types.js'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import { Modal } from '../ui/Modal.js'

export type MemberForm = { email: string; role: string }
export type PendingInvite = { id: string; email: string; role: string; expiresAt: string }

export function TeamSection({
  members, membersLoading, isOwnerOrAdmin,
  memberForm, setMemberForm, addingMember, onAddMember,
  removingMemberId, removeMemberTarget, onRemoveRequest, onCloseRemoveModal, onConfirmRemove,
  pendingInvites, inviteForm, setInviteForm, sendingInvite, onSendInvite, onCancelInvite,
}: {
  members: WorkspaceMember[]
  membersLoading: boolean
  isOwnerOrAdmin: boolean
  memberForm: MemberForm
  setMemberForm: React.Dispatch<React.SetStateAction<MemberForm>>
  addingMember: boolean
  onAddMember: () => void
  removingMemberId: string | null
  removeMemberTarget: WorkspaceMember | null
  onRemoveRequest: (m: WorkspaceMember) => void
  onCloseRemoveModal: () => void
  onConfirmRemove: () => void
  pendingInvites: PendingInvite[]
  inviteForm: MemberForm
  setInviteForm: React.Dispatch<React.SetStateAction<MemberForm>>
  sendingInvite: boolean
  onSendInvite: () => void
  onCancelInvite: (inviteId: string) => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Team</div>
      {membersLoading ? (
        <div style={{ padding: 16, textAlign: 'center' }}><Spinner /></div>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            {members.map(m => (
              <div key={m.id} style={{
                ...s.cardInner,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between'
              }}>
                <div>
                  <div style={{ color: colors.text, fontSize: 14, fontWeight: 500 }}>
                    {m.user.name || m.user.email}
                  </div>
                  {m.user.name && (
                    <div style={{ color: colors.textFaint, fontSize: 12 }}>{m.user.email}</div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    background: m.role === 'owner' ? colors.purple + '22' : colors.blue + '22',
                    color: m.role === 'owner' ? colors.purple : colors.blue,
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                    textTransform: 'capitalize'
                  }}>{m.role}</span>
                  {isOwnerOrAdmin && m.role !== 'owner' && (
                    <button
                      style={s.btnDanger}
                      disabled={removingMemberId === m.user.id}
                      onClick={() => onRemoveRequest(m)}
                    >
                      {removingMemberId === m.user.id ? <Spinner size={12} /> : '✕'}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {members.length === 0 && (
              <div style={{ color: colors.textFaint, fontSize: 13 }}>No members yet.</div>
            )}
          </div>

          {isOwnerOrAdmin && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 8 }}>
                <div>
                  <label style={s.label} htmlFor="settings-field-7">Email (existing account)</label>
                  <input id="settings-field-7"
                    style={{ ...s.input, width: 220 }}
                    placeholder="colleague@company.com"
                    value={memberForm.email}
                    onChange={e => setMemberForm(f => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={s.label} htmlFor="settings-field-8">Role</label>
                  <select id="settings-field-8"
                    style={{ ...s.input, width: 120 }}
                    value={memberForm.role}
                    onChange={e => setMemberForm(f => ({ ...f, role: e.target.value }))}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button
                  style={s.btn}
                  disabled={addingMember || !memberForm.email.trim()}
                  onClick={onAddMember}
                >
                  {addingMember ? <><Spinner size={14} color="#fff" /> Adding…</> : 'Add Member'}
                </button>
              </div>
              <div style={{ borderTop: `1px solid #1f2937`, paddingTop: 12, marginTop: 8 }}>
                <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Send Invite Email</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <label style={s.label} htmlFor="settings-field-9">Email</label>
                    <input id="settings-field-9"
                      style={{ ...s.input, width: 220 }}
                      placeholder="new-user@company.com"
                      value={inviteForm.email}
                      onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={s.label} htmlFor="settings-field-10">Role</label>
                    <select id="settings-field-10"
                      style={{ ...s.input, width: 120 }}
                      value={inviteForm.role}
                      onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <button
                    style={{ ...s.btn, background: colors.purple }}
                    disabled={sendingInvite || !inviteForm.email.trim()}
                    onClick={onSendInvite}
                  >
                    {sendingInvite ? <><Spinner size={14} color="#fff" /> Sending…</> : 'Send Invite'}
                  </button>
                </div>
                {pendingInvites.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Pending Invites</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {pendingInvites.map(inv => (
                        <div key={inv.id} style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div>
                            <span style={{ color: colors.text, fontSize: 13 }}>{inv.email}</span>
                            <span style={{ color: colors.textFaint, fontSize: 12, marginLeft: 8 }}>({inv.role})</span>
                          </div>
                          <button style={s.btnDanger} aria-label={`Cancel invite for ${inv.email}`} onClick={() => onCancelInvite(inv.id)}>✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      <Modal
        open={!!removeMemberTarget}
        onClose={onCloseRemoveModal}
        title="Remove member?"
        footer={<>
          <button style={s.btnSecondary} onClick={onCloseRemoveModal}>Cancel</button>
          <button style={s.btnDanger} onClick={onConfirmRemove}>Remove</button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14 }}>
          Remove {removeMemberTarget?.user.name || removeMemberTarget?.user.email} from this workspace?
        </div>
      </Modal>
    </div>
  )
}

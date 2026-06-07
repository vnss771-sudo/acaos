import React, { useState, useEffect } from 'react'
import type { User, Workspace, WorkspaceMember, WorkspaceInvite } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  user: User
  workspace: Workspace | null
  toast: ToastHook
  onUserUpdate: (u: User) => void
  onWorkspaceUpdate: (w: Workspace) => void
}

function RoleBadge({ role }: { role: string }) {
  const color = role === 'owner' ? colors.amber : role === 'admin' ? colors.blue : colors.textFaint
  return (
    <span style={{ ...s.badge(color), fontSize: 10, padding: '2px 6px', textTransform: 'capitalize' }}>{role}</span>
  )
}

export function Settings({ api, user, workspace, toast, onUserUpdate, onWorkspaceUpdate }: Props) {
  const [profileForm, setProfileForm] = useState({ name: user.name ?? '' })
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [wsForm, setWsForm] = useState({ name: workspace?.name ?? '', slug: workspace?.slug ?? '' })
  const [webhookUrl, setWebhookUrl] = useState('')
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [invites, setInvites] = useState<WorkspaceInvite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [ingestKey, setIngestKey] = useState<string | null>(null)

  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingWs, setSavingWs] = useState(false)
  const [savingWebhook, setSavingWebhook] = useState(false)
  const [sendingInvite, setSendingInvite] = useState(false)
  const [rotatingKey, setRotatingKey] = useState(false)

  const isOwnerOrAdmin = members.find(m => m.user.id === user.id && ['owner', 'admin'].includes(m.role))

  useEffect(() => {
    if (!workspace) return
    // Load members and pending invites
    api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`)
      .then(d => setMembers(d.members)).catch(() => {})
    api<{ invites: WorkspaceInvite[] }>(`/api/invites?workspaceId=${workspace.id}`)
      .then(d => setInvites(d.invites)).catch(() => {})
    // Load workspace settings (includes webhookUrl and ingestApiKey)
    api<{ workspace: { webhookUrl?: string | null; ingestApiKey?: string | null } }>(`/api/workspaces/${workspace.id}/settings`)
      .then(d => {
        setWebhookUrl(d.workspace.webhookUrl ?? '')
        setIngestKey(d.workspace.ingestApiKey ?? null)
      }).catch(() => {})
  }, [workspace?.id])

  async function saveProfile() {
    setSavingProfile(true)
    try {
      const d = await api<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: profileForm.name.trim() || null })
      })
      onUserUpdate(d.user)
      toast.success('Profile updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSavingProfile(false) }
  }

  async function changePassword() {
    if (passwordForm.newPassword !== passwordForm.confirmPassword) { toast.error('Passwords do not match'); return }
    if (passwordForm.newPassword.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setSavingPassword(true)
    try {
      await api('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword })
      })
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      toast.success('Password changed successfully')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Password change failed') }
    finally { setSavingPassword(false) }
  }

  async function saveWorkspace() {
    if (!workspace) return
    setSavingWs(true)
    try {
      const d = await api<{ workspace: Workspace }>(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: wsForm.name.trim(), slug: wsForm.slug.trim() })
      })
      onWorkspaceUpdate(d.workspace)
      toast.success('Workspace updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSavingWs(false) }
  }

  async function saveWebhook() {
    if (!workspace) return
    setSavingWebhook(true)
    try {
      await api<{ workspace: Workspace }>(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ webhookUrl: webhookUrl.trim() || null })
      })
      toast.success('Webhook URL saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSavingWebhook(false) }
  }

  async function sendInvite() {
    if (!workspace || !inviteEmail.trim()) return
    setSendingInvite(true)
    try {
      const d = await api<{ invite: WorkspaceInvite & { token?: string } }>('/api/invites', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id, email: inviteEmail.trim(), role: inviteRole })
      })
      setInvites(prev => [...prev.filter(i => i.email !== inviteEmail.trim()), d.invite])
      setInviteEmail('')
      if (d.invite.token) {
        // Mail not configured — show token for manual sharing
        const url = `${window.location.origin}/invite/${d.invite.token}`
        toast.success(`Invite created — share this link: ${url}`)
      } else {
        toast.success(`Invite sent to ${inviteEmail.trim()}`)
      }
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Invite failed') }
    finally { setSendingInvite(false) }
  }

  async function revokeInvite(inviteId: string) {
    if (!workspace) return
    try {
      await api(`/api/invites/${inviteId}`, { method: 'DELETE' })
      setInvites(prev => prev.filter(i => i.id !== inviteId))
      toast.success('Invite revoked')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function removeMember(memberId: string) {
    if (!workspace) return
    if (!confirm('Remove this member from the workspace?')) return
    try {
      await api(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: 'DELETE' })
      setMembers(prev => prev.filter(m => m.id !== memberId))
      toast.success('Member removed')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function rotateIngestKey() {
    if (!workspace) return
    if (!confirm('Rotate the ingest API key? The current key will stop working immediately.')) return
    setRotatingKey(true)
    try {
      const d = await api<{ ingestApiKey: string }>(`/api/ingest/keys/rotate?workspaceId=${workspace.id}`, { method: 'POST' })
      setIngestKey(d.ingestApiKey)
      toast.success('API key rotated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setRotatingKey(false) }
  }

  return (
    <div style={s.stack}>
      {/* Profile */}
      <div style={s.card}>
        <div style={s.sectionHeader}>Profile</div>
        <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
          <div>
            <label style={s.label}>Email</label>
            <input style={{ ...s.input, opacity: 0.6, cursor: 'not-allowed' }} value={user.email} disabled />
          </div>
          <div>
            <label style={s.label}>Name</label>
            <input style={s.input} value={profileForm.name} onChange={e => setProfileForm({ name: e.target.value })} placeholder="Your name" />
          </div>
        </div>
        <button style={s.btn} disabled={savingProfile} onClick={saveProfile}>
          {savingProfile ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Profile'}
        </button>
      </div>

      {/* Change password */}
      <div style={s.card}>
        <div style={s.sectionHeader}>Change Password</div>
        <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
          {[
            { label: 'Current Password', field: 'currentPassword', autocomplete: 'current-password' },
            { label: 'New Password', field: 'newPassword', autocomplete: 'new-password' },
            { label: 'Confirm New Password', field: 'confirmPassword', autocomplete: 'new-password' }
          ].map(({ label, field, autocomplete }) => (
            <div key={field}>
              <label style={s.label}>{label}</label>
              <input
                style={s.input}
                type="password"
                value={(passwordForm as Record<string, string>)[field]}
                onChange={e => setPasswordForm(f => ({ ...f, [field]: e.target.value }))}
                autoComplete={autocomplete}
              />
            </div>
          ))}
        </div>
        <button style={s.btn} disabled={savingPassword} onClick={changePassword}>
          {savingPassword ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Change Password'}
        </button>
      </div>

      {/* Workspace settings */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Workspace</div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
            <div>
              <label style={s.label}>Workspace Name</label>
              <input style={s.input} value={wsForm.name} onChange={e => setWsForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label style={s.label}>Slug</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: colors.textFaint, fontSize: 14 }}>acaos.app/</span>
                <input
                  style={{ ...s.input, flex: 1 }}
                  value={wsForm.slug}
                  onChange={e => setWsForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                />
              </div>
            </div>
          </div>
          <button style={s.btn} disabled={savingWs} onClick={saveWorkspace}>
            {savingWs ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Workspace'}
          </button>
        </div>
      )}

      {/* Team Members */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Team Members</div>

          {/* Member list */}
          <div style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
            {members.map(m => (
              <div key={m.id} style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ color: colors.text, fontSize: 14, fontWeight: 500 }}>{m.user.name || m.user.email}</div>
                  <div style={{ color: colors.textFaint, fontSize: 12 }}>{m.user.email}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RoleBadge role={m.role} />
                  {isOwnerOrAdmin && m.user.id !== user.id && m.role !== 'owner' && (
                    <button style={s.btnDanger} onClick={() => removeMember(m.id)}>Remove</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Pending invites */}
          {invites.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>Pending Invites</div>
              {invites.map(inv => (
                <div key={inv.id} style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div>
                    <div style={{ color: colors.textMuted, fontSize: 14 }}>{inv.email}</div>
                    <div style={{ color: colors.textFaint, fontSize: 11 }}>Expires {new Date(inv.expiresAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <RoleBadge role={inv.role} />
                    <button style={s.btnDanger} onClick={() => revokeInvite(inv.id)}>Revoke</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Invite form */}
          {isOwnerOrAdmin && (
            <div>
              <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>Invite Someone</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...s.input, flex: 1 }}
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendInvite()}
                />
                <select
                  style={{ ...s.input, width: 'auto', minWidth: 100 }}
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'member' | 'admin')}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button style={s.btn} disabled={sendingInvite || !inviteEmail.trim()} onClick={sendInvite}>
                  {sendingInvite ? <Spinner size={14} color="#fff" /> : 'Send Invite'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Webhook */}
      {workspace && isOwnerOrAdmin && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Webhook</div>
          <p style={{ color: colors.textFaint, fontSize: 13, margin: '0 0 12px' }}>
            ACAOS will POST stage-change events to this URL (lead.stage_changed, lead.booked, lead.closed, etc.)
          </p>
          <div style={{ display: 'flex', gap: 8, maxWidth: 600, marginBottom: 8 }}>
            <input
              style={{ ...s.input, flex: 1 }}
              placeholder="https://your-app.com/webhooks/acaos"
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
            />
            <button style={s.btn} disabled={savingWebhook} onClick={saveWebhook}>
              {savingWebhook ? <Spinner size={14} color="#fff" /> : 'Save'}
            </button>
          </div>
          {webhookUrl && (
            <div style={{ color: colors.textFaint, fontSize: 12 }}>Payload: <code style={{ color: colors.textMuted }}>{"{ event, workspaceId, timestamp, data: { leadId, fromStage, toStage } }"}</code></div>
          )}
        </div>
      )}

      {/* Ingest API Key */}
      {workspace && isOwnerOrAdmin && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Ingest API Key</div>
          <p style={{ color: colors.textFaint, fontSize: 13, margin: '0 0 12px' }}>
            Use this key to push leads programmatically via <code style={{ color: colors.textMuted }}>POST /api/ingest</code> with header <code style={{ color: colors.textMuted }}>x-api-key</code>.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {ingestKey ? (
              <code style={{ ...s.cardInner, flex: 1, fontSize: 12, color: colors.textMuted, wordBreak: 'break-all', display: 'block', padding: '10px 14px' }}>
                {ingestKey}
              </code>
            ) : (
              <span style={{ color: colors.textFaint, fontSize: 13 }}>No key yet — click Rotate to generate one.</span>
            )}
            <button style={s.btnSm} disabled={rotatingKey} onClick={rotateIngestKey}>
              {rotatingKey ? <Spinner size={13} /> : 'Rotate'}
            </button>
          </div>
        </div>
      )}

      {/* Workspace info */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Workspace Info</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              { label: 'Workspace ID', value: workspace.id },
              { label: 'Plan', value: workspace.plan.charAt(0).toUpperCase() + workspace.plan.slice(1) },
              { label: 'Total Leads', value: String(workspace._count?.leads ?? '–') },
              { label: 'Total Campaigns', value: String(workspace._count?.campaigns ?? '–') }
            ].map(({ label, value }) => (
              <div key={label} style={s.cardInner}>
                <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
                <div style={{ color: colors.text, fontSize: 14, fontFamily: label === 'Workspace ID' ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

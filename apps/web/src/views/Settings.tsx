import React, { useState } from 'react'
import type { User, Workspace } from '../types.js'
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

export function Settings({ api, user, workspace, toast, onUserUpdate, onWorkspaceUpdate }: Props) {
  const [profileForm, setProfileForm] = useState({ name: user.name ?? '' })
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [wsForm, setWsForm] = useState({ name: workspace?.name ?? '', slug: workspace?.slug ?? '' })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingWs, setSavingWs] = useState(false)

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
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    if (passwordForm.newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
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
                minLength={field !== 'currentPassword' ? 8 : undefined}
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

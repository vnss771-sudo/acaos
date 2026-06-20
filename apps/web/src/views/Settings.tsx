import React, { useState, useEffect, useMemo } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey.js'
import type { User, Workspace, WorkspaceMember } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import { MfaSettings } from '../components/MfaSettings.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type IcpConfig = {
  targetIndustries: string[]
  targetGeos: string[]
  minEmployees: number | null
  maxEmployees: number | null
  mustHaveEmail: boolean
  approvalMode?: boolean
  dailySendLimit?: number
}

type DomainCheckResult = {
  hasSPF: boolean
  hasDKIM: boolean
} | null

type EmailConfigState = {
  smtpHost: string
  smtpPort: string
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
  smtpFrom: string
  imapHost: string
  imapPort: string
  imapSecure: boolean
  imapUser: string
  imapPass: string
  smtpPassSet: boolean
  imapPassSet: boolean
}

type Props = {
  api: ApiHook
  user: User
  workspace: Workspace | null
  toast: ToastHook
  onUserUpdate: (u: User) => void
  onWorkspaceUpdate: (w: Workspace) => void
  canManage?: boolean
}

export function Settings({ api, user, workspace, toast, onUserUpdate, onWorkspaceUpdate, canManage = false }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [profileForm, setProfileForm] = useState({ name: user.name ?? '' })
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [wsForm, setWsForm] = useState({ name: workspace?.name ?? '', slug: workspace?.slug ?? '', senderBusinessName: workspace?.senderBusinessName ?? '', senderPostalAddress: workspace?.senderPostalAddress ?? '' })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingWs, setSavingWs] = useState(false)

  // Team
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberForm, setMemberForm] = useState({ email: '', role: 'member' })
  const [addingMember, setAddingMember] = useState(false)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
  const [pendingInvites, setPendingInvites] = useState<{ id: string; email: string; role: string; expiresAt: string }[]>([])
  const [sendingInvite, setSendingInvite] = useState(false)
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'member' })

  // ICP
  const [icp, setIcp] = useState<IcpConfig | null>(null)
  const [icpForm, setIcpForm] = useState({ targetIndustries: '', targetGeos: '', minEmployees: '', maxEmployees: '', mustHaveEmail: false })
  const [savingIcp, setSavingIcp] = useState(false)

  // Email config
  const emptyEmail: EmailConfigState = { smtpHost: '', smtpPort: '587', smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', imapHost: '', imapPort: '993', imapSecure: true, imapUser: '', imapPass: '', smtpPassSet: false, imapPassSet: false }
  const [emailForm, setEmailForm] = useState<EmailConfigState>(emptyEmail)
  const [savingEmail, setSavingEmail] = useState(false)

  // API Keys
  const [keyWorking, setKeyWorking] = useState(false)
  const [newKeyModal, setNewKeyModal] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [hasKey, setHasKey] = useState(!!workspace?.ingestApiKey)

  // Compliance & Deliverability
  const [domainCheck, setDomainCheck] = useState<DomainCheckResult>(null)
  const [domainCheckLoading, setDomainCheckLoading] = useState(false)
  const [suppressionCount, setSuppressionCount] = useState<number | null>(null)

  useEffect(() => {
    setHasKey(!!workspace?.ingestApiKey)
  }, [workspace?.ingestApiKey])

  useEffect(() => {
    if (!workspace) return
    // Drop results from a superseded workspace so a slow response for the previous
    // workspace can't populate the current one's settings forms.
    let cancelled = false
    setMembersLoading(true)
    api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`)
      .then(d => { if (!cancelled) setMembers(d.members || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setMembersLoading(false) })
    api<{ invites: typeof pendingInvites }>(`/api/workspaces/${workspace.id}/invites`)
      .then(d => { if (!cancelled) setPendingInvites(d.invites || []) })
      .catch(() => {})
    api<{ icp: IcpConfig | null }>(`/api/workspaces/${workspace.id}/icp`)
      .then(d => {
        if (d.icp && !cancelled) {
          setIcp(d.icp)
          setIcpForm({
            targetIndustries: d.icp.targetIndustries.join(', '),
            targetGeos: d.icp.targetGeos.join(', '),
            minEmployees: d.icp.minEmployees != null ? String(d.icp.minEmployees) : '',
            maxEmployees: d.icp.maxEmployees != null ? String(d.icp.maxEmployees) : '',
            mustHaveEmail: d.icp.mustHaveEmail,
          })
        }
      })
      .catch(() => {})
    api<{ config: Record<string, unknown> | null }>(`/api/workspaces/${workspace.id}/email-config`)
      .then(d => {
        if (d.config && !cancelled) {
          setEmailForm({
            smtpHost: String(d.config.smtpHost ?? ''),
            smtpPort: String(d.config.smtpPort ?? '587'),
            smtpSecure: Boolean(d.config.smtpSecure),
            smtpUser: String(d.config.smtpUser ?? ''),
            smtpPass: '', // never returned
            smtpFrom: String(d.config.smtpFrom ?? ''),
            imapHost: String(d.config.imapHost ?? ''),
            imapPort: String(d.config.imapPort ?? '993'),
            imapSecure: Boolean(d.config.imapSecure ?? true),
            imapUser: String(d.config.imapUser ?? ''),
            imapPass: '', // never returned
            smtpPassSet: Boolean(d.config.smtpPassSet),
            imapPassSet: Boolean(d.config.imapPassSet),
          })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspace?.id])

  // Compliance: fetch domain check and suppression count when email config is set
  useEffect(() => {
    if (!workspace) return
    const smtpFrom = emailForm.smtpFrom
    if (!smtpFrom) {
      setDomainCheck(null)
      return
    }
    const atIdx = smtpFrom.lastIndexOf('@')
    const domain = atIdx !== -1 ? smtpFrom.slice(atIdx + 1).replace(/[>\s]+$/, '').trim() : ''
    if (!domain) {
      setDomainCheck(null)
      return
    }
    let cancelled = false
    setDomainCheckLoading(true)
    api<{ hasSPF: boolean; hasDKIM: boolean }>(
      `/api/mailbox/check-domain?domain=${encodeURIComponent(domain)}&workspaceId=${encodeURIComponent(workspace.id)}`
    )
      .then(result => { if (!cancelled) setDomainCheck({ hasSPF: result.hasSPF, hasDKIM: result.hasDKIM }) })
      .catch(() => { if (!cancelled) setDomainCheck(null) })
      .finally(() => { if (!cancelled) setDomainCheckLoading(false) })
    return () => { cancelled = true }
  }, [api, workspace?.id, emailForm.smtpFrom])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    api<{ suppressions: { id: string }[] }>(`/api/unsubscribe?workspaceId=${workspace.id}`)
      .then(d => { if (!cancelled) setSuppressionCount(d.suppressions?.length ?? 0) })
      .catch(() => { if (!cancelled) setSuppressionCount(null) })
    return () => { cancelled = true }
  }, [api, workspace?.id])

  // Dismiss the API-key modal with Escape (only active while it's open).
  useEscapeKey(() => setNewKeyModal(null), !!newKeyModal)

  async function saveProfile() {
    setSavingProfile(true)
    try {
      const d = await route('PATCH /api/auth/profile', { body: { name: profileForm.name.trim() || null } }) as { user: User }
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
    if (passwordForm.newPassword.length < 12) {
      toast.error('Password must be at least 12 characters')
      return
    }
    setSavingPassword(true)
    try {
      await route('PATCH /api/auth/profile', { body: { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword } })
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      toast.success('Password changed successfully')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Password change failed') }
    finally { setSavingPassword(false) }
  }

  async function saveWorkspace() {
    if (!workspace) return
    setSavingWs(true)
    try {
      const d = await route('PATCH /api/workspaces/:id', {
        params: { id: workspace.id },
        body: {
          name: wsForm.name.trim(),
          slug: wsForm.slug.trim(),
          senderBusinessName: wsForm.senderBusinessName.trim() || null,
          senderPostalAddress: wsForm.senderPostalAddress.trim() || null,
        }
      }) as { workspace: Workspace }
      onWorkspaceUpdate(d.workspace)
      toast.success('Workspace updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSavingWs(false) }
  }

  async function addMember() {
    if (!workspace || !memberForm.email.trim()) return
    setAddingMember(true)
    try {
      await route('POST /api/workspaces/:id/members', {
        params: { id: workspace.id },
        body: { email: memberForm.email.trim(), role: memberForm.role }
      })
      const refreshed = await api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`)
      setMembers(refreshed.members || [])
      setMemberForm({ email: '', role: 'member' })
      toast.success('Member added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add member') }
    finally { setAddingMember(false) }
  }

  async function removeMember(userId: string) {
    if (!workspace || !confirm('Remove this member?')) return
    setRemovingMemberId(userId)
    try {
      await route('DELETE /api/workspaces/:id/members/:userId', { params: { id: workspace.id, userId } })
      setMembers(prev => prev.filter(m => m.user.id !== userId))
      toast.success('Member removed')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to remove member') }
    finally { setRemovingMemberId(null) }
  }

  async function sendInvite() {
    if (!workspace || !inviteForm.email.trim()) return
    setSendingInvite(true)
    try {
      await route('POST /api/workspaces/:id/invites', {
        params: { id: workspace.id },
        body: { email: inviteForm.email.trim(), role: inviteForm.role }
      })
      setInviteForm({ email: '', role: 'member' })
      toast.success('Invite sent')
      // Refresh pending invites
      const d = await api<{ invites: typeof pendingInvites }>(`/api/workspaces/${workspace.id}/invites`)
      setPendingInvites(d.invites || [])
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to send invite') }
    finally { setSendingInvite(false) }
  }

  async function cancelInvite(inviteId: string) {
    if (!workspace) return
    try {
      await route('DELETE /api/workspaces/:id/invites/:inviteId', { params: { id: workspace.id, inviteId } })
      setPendingInvites(prev => prev.filter(i => i.id !== inviteId))
      toast.success('Invite cancelled')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveEmailConfig() {
    if (!workspace) return
    setSavingEmail(true)
    try {
      await route('PUT /api/workspaces/:id/email-config', {
        params: { id: workspace.id },
        body: {
          smtpHost: emailForm.smtpHost || null,
          smtpPort: emailForm.smtpPort ? parseInt(emailForm.smtpPort, 10) : null,
          smtpSecure: emailForm.smtpSecure,
          smtpUser: emailForm.smtpUser || null,
          smtpPass: emailForm.smtpPass || null, // null = keep existing
          smtpFrom: emailForm.smtpFrom || null,
          imapHost: emailForm.imapHost || null,
          imapPort: emailForm.imapPort ? parseInt(emailForm.imapPort, 10) : null,
          imapSecure: emailForm.imapSecure,
          imapUser: emailForm.imapUser || null,
          imapPass: emailForm.imapPass || null, // null = keep existing
        }
      })
      toast.success('Email config saved')
      setEmailForm(f => ({ ...f, smtpPass: '', imapPass: '', smtpPassSet: !!f.smtpHost, imapPassSet: !!f.imapHost }))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save email config') }
    finally { setSavingEmail(false) }
  }

  async function saveIcp() {
    if (!workspace) return
    setSavingIcp(true)
    try {
      const d = await route('PUT /api/workspaces/:id/icp', {
        params: { id: workspace.id },
        body: {
          targetIndustries: icpForm.targetIndustries.split(',').map(s => s.trim()).filter(Boolean),
          targetGeos: icpForm.targetGeos.split(',').map(s => s.trim()).filter(Boolean),
          minEmployees: icpForm.minEmployees ? parseInt(icpForm.minEmployees, 10) : null,
          maxEmployees: icpForm.maxEmployees ? parseInt(icpForm.maxEmployees, 10) : null,
          mustHaveEmail: icpForm.mustHaveEmail,
        }
      }) as { icp: IcpConfig }
      setIcp(d.icp)
      toast.success('ICP settings saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save ICP') }
    finally { setSavingIcp(false) }
  }

  async function generateApiKey() {
    if (!workspace) return
    setKeyWorking(true)
    try {
      const d = await route('POST /api/workspaces/:id/api-key/rotate', { params: { id: workspace.id } })
      setNewKeyModal(d.apiKey)
      setHasKey(true)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to generate key') }
    finally { setKeyWorking(false) }
  }

  async function revokeApiKey() {
    if (!workspace || !confirm('Revoke this API key? All integrations using it will stop working.')) return
    setKeyWorking(true)
    try {
      await route('DELETE /api/workspaces/:id/api-key', { params: { id: workspace.id } })
      setHasKey(false)
      toast.success('API key revoked')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to revoke key') }
    finally { setKeyWorking(false) }
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key).then(() => {
      setKeyCopied(true)
      setTimeout(() => setKeyCopied(false), 2000)
    })
  }

  // Prefer the role threaded from the workspace (canManage); fall back to the
  // membership list once it loads. Either source gates the admin-only sections.
  const myMembership = members.find(m => m.user.id === user.id)
  const isOwnerOrAdmin = canManage || myMembership?.role === 'owner' || myMembership?.role === 'admin'

  return (
    <div style={s.stack}>
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
              <button style={s.btn} onClick={() => copyKey(newKeyModal)}>
                {keyCopied ? '✓ Copied' : 'Copy Key'}
              </button>
              <button style={s.btnGhost} onClick={() => { setNewKeyModal(null); setKeyCopied(false) }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Profile */}
      <div style={s.card}>
        <div style={s.sectionHeader}>Profile</div>
        {!user.emailVerified && (
          <div style={{ background: '#422006', border: '1px solid #92400e', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#fbbf24', fontSize: 13 }}>Your email address is not verified.</span>
            <button
              style={{ ...s.btnSm, background: '#92400e', color: '#fbbf24', flexShrink: 0 }}
              onClick={() => route('POST /api/auth/resend-verification').then(() => toast.success('Verification email sent')).catch(() => toast.error('Failed to send'))}
            >
              Resend
            </button>
          </div>
        )}
        <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
          <div>
            <label style={s.label} htmlFor="settings-field-0">Email</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input id="settings-field-0" style={{ ...s.input, flex: 1, opacity: 0.6, cursor: 'not-allowed' }} value={user.email} disabled />
              {user.emailVerified && <span style={{ color: '#22c55e', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>✓ Verified</span>}
            </div>
          </div>
          <div>
            <label style={s.label} htmlFor="settings-field-1">Name</label>
            <input id="settings-field-1" style={s.input} value={profileForm.name} onChange={e => setProfileForm({ name: e.target.value })} placeholder="Your name" />
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
              <label style={s.label} htmlFor="settings-field-2">{label}</label>
              <input id="settings-field-2"
                style={s.input}
                type="password"
                value={(passwordForm as Record<string, string>)[field]}
                onChange={e => setPasswordForm(f => ({ ...f, [field]: e.target.value }))}
                autoComplete={autocomplete}
                minLength={field !== 'currentPassword' ? 12 : undefined}
              />
            </div>
          ))}
        </div>
        <button style={s.btn} disabled={savingPassword} onClick={changePassword}>
          {savingPassword ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Change Password'}
        </button>
      </div>

      {/* Security / Two-factor authentication */}
      <MfaSettings
        api={api}
        enabled={!!user.totpEnabled}
        onEnabledChange={(totpEnabled) => onUserUpdate({ ...user, totpEnabled })}
        toast={toast}
      />

      {/* Workspace settings */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Workspace</div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
            <div>
              <label style={s.label} htmlFor="settings-field-3">Workspace Name</label>
              <input id="settings-field-3" style={s.input} value={wsForm.name} onChange={e => setWsForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label style={s.label} htmlFor="settings-field-4">Slug</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: colors.textFaint, fontSize: 14 }}>acaos.app/</span>
                <input id="settings-field-4"
                  style={{ ...s.input, flex: 1 }}
                  value={wsForm.slug}
                  onChange={e => setWsForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                />
              </div>
            </div>
            <div>
              <label style={s.label} htmlFor="settings-field-5">Sender Business Name <span style={{ color: colors.textFaint, fontWeight: 400 }}>(CAN-SPAM / GDPR)</span></label>
              <input id="settings-field-5" style={s.input} placeholder="Acme Services LLC" value={wsForm.senderBusinessName} onChange={e => setWsForm(f => ({ ...f, senderBusinessName: e.target.value }))} />
            </div>
            <div>
              <label style={s.label} htmlFor="settings-field-6">Sender Postal Address</label>
              <input id="settings-field-6" style={s.input} placeholder="123 Main St, City, ST 00000, USA" value={wsForm.senderPostalAddress} onChange={e => setWsForm(f => ({ ...f, senderPostalAddress: e.target.value }))} />
              <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>Included in outbound email footer to meet commercial email regulations.</div>
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
                          onClick={() => removeMember(m.user.id)}
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
                      onClick={addMember}
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
                        onClick={sendInvite}
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
                              <button style={s.btnDanger} aria-label={`Cancel invite for ${inv.email}`} onClick={() => cancelInvite(inv.id)}>✕</button>
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
        </div>
      )}

      {/* Ideal Customer Profile */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Ideal Customer Profile (ICP)</div>
          <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
            Defines the types of prospects ACAOS targets when scoring and filtering leads.
          </div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 500, marginBottom: 16 }}>
            <div>
              <label style={s.label} htmlFor="settings-field-11">Target Industries (comma-separated)</label>
              <input id="settings-field-11"
                style={s.input}
                placeholder="e.g. HVAC, Electrical, Plumbing"
                value={icpForm.targetIndustries}
                onChange={e => setIcpForm(f => ({ ...f, targetIndustries: e.target.value }))}
              />
            </div>
            <div>
              <label style={s.label} htmlFor="settings-field-12">Target Geographies (comma-separated)</label>
              <input id="settings-field-12"
                style={s.input}
                placeholder="e.g. Brisbane, Sydney, Melbourne"
                value={icpForm.targetGeos}
                onChange={e => setIcpForm(f => ({ ...f, targetGeos: e.target.value }))}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={s.label} htmlFor="settings-field-13">Min Employees</label>
                <input id="settings-field-13"
                  style={s.input}
                  type="number"
                  min="0"
                  placeholder="e.g. 5"
                  value={icpForm.minEmployees}
                  onChange={e => setIcpForm(f => ({ ...f, minEmployees: e.target.value }))}
                />
              </div>
              <div>
                <label style={s.label} htmlFor="settings-field-14">Max Employees</label>
                <input id="settings-field-14"
                  style={s.input}
                  type="number"
                  min="0"
                  placeholder="e.g. 200"
                  value={icpForm.maxEmployees}
                  onChange={e => setIcpForm(f => ({ ...f, maxEmployees: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                id="mustHaveEmail"
                checked={icpForm.mustHaveEmail}
                onChange={e => setIcpForm(f => ({ ...f, mustHaveEmail: e.target.checked }))}
                style={{ accentColor: colors.blue, width: 16, height: 16 }}
              />
              <label htmlFor="mustHaveEmail" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
                Only score prospects that have an email address
              </label>
            </div>
          </div>
          <button style={s.btn} disabled={savingIcp} onClick={saveIcp}>
            {savingIcp ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save ICP'}
          </button>
        </div>
      )}

      {/* Email Configuration */}
      {workspace && isOwnerOrAdmin && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Email Configuration</div>
          <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
            Per-workspace SMTP/IMAP settings. Leave blank to use the server defaults.
          </div>
          <div style={{ display: 'grid', gap: 16 }}>
            <div>
              <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>SMTP (outbound)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Host', field: 'smtpHost', placeholder: 'smtp.gmail.com' },
                  { label: 'Port', field: 'smtpPort', placeholder: '587' },
                  { label: 'Username', field: 'smtpUser', placeholder: 'you@gmail.com' },
                  { label: emailForm.smtpPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'smtpPass', placeholder: '••••••••' },
                  { label: 'From Address', field: 'smtpFrom', placeholder: 'You <you@company.com>' },
                ].map(({ label, field, placeholder }) => (
                  <div key={field} style={field === 'smtpFrom' ? { gridColumn: '1/-1' } : {}}>
                    <label style={s.label} htmlFor="settings-field-15">{label}</label>
                    <input id="settings-field-15"
                      style={s.input}
                      type={field === 'smtpPass' ? 'password' : 'text'}
                      placeholder={placeholder}
                      value={(emailForm as Record<string, unknown>)[field] as string}
                      onChange={e => setEmailForm(f => ({ ...f, [field]: e.target.value }))}
                      autoComplete={field === 'smtpPass' ? 'new-password' : 'off'}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1/-1' }}>
                  <input
                    type="checkbox"
                    id="smtpSecure"
                    checked={emailForm.smtpSecure}
                    onChange={e => setEmailForm(f => ({ ...f, smtpSecure: e.target.checked }))}
                    style={{ accentColor: colors.blue, width: 16, height: 16 }}
                  />
                  <label htmlFor="smtpSecure" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
                    Use SSL/TLS (port 465)
                  </label>
                </div>
              </div>
            </div>
            <div>
              <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>IMAP (inbound reply tracking)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Host', field: 'imapHost', placeholder: 'imap.gmail.com' },
                  { label: 'Port', field: 'imapPort', placeholder: '993' },
                  { label: 'Username', field: 'imapUser', placeholder: 'you@gmail.com' },
                  { label: emailForm.imapPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'imapPass', placeholder: '••••••••' },
                ].map(({ label, field, placeholder }) => (
                  <div key={field}>
                    <label style={s.label} htmlFor="settings-field-16">{label}</label>
                    <input id="settings-field-16"
                      style={s.input}
                      type={field === 'imapPass' ? 'password' : 'text'}
                      placeholder={placeholder}
                      value={(emailForm as Record<string, unknown>)[field] as string}
                      onChange={e => setEmailForm(f => ({ ...f, [field]: e.target.value }))}
                      autoComplete={field === 'imapPass' ? 'new-password' : 'off'}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1/-1' }}>
                  <input
                    type="checkbox"
                    id="imapSecure"
                    checked={emailForm.imapSecure}
                    onChange={e => setEmailForm(f => ({ ...f, imapSecure: e.target.checked }))}
                    style={{ accentColor: colors.blue, width: 16, height: 16 }}
                  />
                  <label htmlFor="imapSecure" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
                    Use SSL/TLS (port 993)
                  </label>
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button style={s.btn} disabled={savingEmail} onClick={saveEmailConfig}>
              {savingEmail ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Email Config'}
            </button>
          </div>
        </div>
      )}

      {/* Compliance & Deliverability */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Compliance &amp; Deliverability</div>
          <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
            Real-time health check for your sending domain and outreach compliance.
          </div>
          {!emailForm.smtpFrom ? (
            <div style={{
              background: '#0f172a', border: `1px solid ${colors.border}`,
              borderRadius: 8, padding: '12px 16px', color: colors.textMuted, fontSize: 13
            }}>
              Configure your email settings above to enable deliverability checks.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {/* Sending domain */}
              <div style={{ ...s.cardInner }}>
                <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                  Sending Domain
                </div>
                {domainCheckLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: colors.textMuted, fontSize: 13 }}>
                    <Spinner size={13} /> Checking DNS records…
                  </div>
                ) : domainCheck ? (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ color: colors.textMuted, fontSize: 13 }}>SPF record</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: domainCheck.hasSPF ? colors.green : colors.red }}>
                        {domainCheck.hasSPF ? '✓ Configured' : '✗ Missing'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ color: colors.textMuted, fontSize: 13 }}>DKIM signature</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: domainCheck.hasDKIM ? colors.green : colors.red }}>
                        {domainCheck.hasDKIM ? '✓ Configured' : '✗ Missing'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: colors.textFaint, fontSize: 13 }}>DNS lookup unavailable</div>
                )}
              </div>

              {/* Unsubscribe coverage */}
              <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Unsubscribe coverage</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.green }}>
                  ✓ All outbound emails include unsubscribe link
                </span>
              </div>

              {/* Suppression list */}
              <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Suppression list</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                  {suppressionCount !== null
                    ? `${suppressionCount} contact${suppressionCount !== 1 ? 's' : ''} suppressed`
                    : 'Active'}
                </span>
              </div>

              {/* Email footer */}
              <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Email footer</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.green }}>
                  ✓ Unsubscribe link included
                </span>
              </div>

              {/* Sending limits */}
              <div style={{ ...s.cardInner }}>
                <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                  Sending Limits
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>Daily limit</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                      {icp?.dailySendLimit != null ? `${icp.dailySendLimit} emails` : '50 emails (default)'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>Approval mode</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: icp?.approvalMode !== false ? colors.amber : colors.green }}>
                      {icp?.approvalMode !== false ? 'ON — campaigns require approval' : 'OFF — campaigns send automatically'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* API Keys */}
      {workspace && (
        <div style={s.card}>
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
            <button style={s.btn} disabled={keyWorking} onClick={generateApiKey}>
              {keyWorking ? <><Spinner size={14} color="#fff" /> Working…</> : 'Generate New Key'}
            </button>
            {hasKey && (
              <button style={{ ...s.btnGhost, color: colors.red }} disabled={keyWorking} onClick={revokeApiKey}>
                Revoke Key
              </button>
            )}
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

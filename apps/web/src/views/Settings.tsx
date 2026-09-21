import React, { useState, useEffect, useMemo } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey.js'
import type { User, Workspace, WorkspaceMember } from '../types.js'
import { s, colors } from '../styles.js'
import { MfaSettings } from '../components/MfaSettings.js'
import { CompliancePanel } from '../components/CompliancePanel.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { ProfileSection } from '../components/settings/ProfileSection.js'
import { PasswordSection, type PasswordForm } from '../components/settings/PasswordSection.js'
import { WorkspaceSection, type WorkspaceForm } from '../components/settings/WorkspaceSection.js'
import { TeamSection, type MemberForm, type PendingInvite } from '../components/settings/TeamSection.js'
import { IcpSection, type IcpForm } from '../components/settings/IcpSection.js'
import { EmailConfigSection, type EmailConfigForm } from '../components/settings/EmailConfigSection.js'
import { DeliverabilitySection, type DomainCheckResult, type WarmupStatus, type ReputationVerdict } from '../components/settings/DeliverabilitySection.js'
import { ApiKeysSection } from '../components/settings/ApiKeysSection.js'
import { WorkspaceInfoSection } from '../components/settings/WorkspaceInfoSection.js'
import { AccessReviewSection } from '../components/settings/AccessReviewSection.js'

type IcpConfig = {
  targetIndustries: string[]
  targetGeos: string[]
  minEmployees: number | null
  maxEmployees: number | null
  mustHaveEmail: boolean
  approvalMode?: boolean
  dailySendLimit?: number
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
  const [passwordForm, setPasswordForm] = useState<PasswordForm>({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [wsForm, setWsForm] = useState<WorkspaceForm>({ name: workspace?.name ?? '', slug: workspace?.slug ?? '', senderBusinessName: workspace?.senderBusinessName ?? '', senderPostalAddress: workspace?.senderPostalAddress ?? '' })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingWs, setSavingWs] = useState(false)

  // Team
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberForm, setMemberForm] = useState<MemberForm>({ email: '', role: 'member' })
  const [addingMember, setAddingMember] = useState(false)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
  const [removeMemberTarget, setRemoveMemberTarget] = useState<WorkspaceMember | null>(null)
  const [revokeKeyConfirmOpen, setRevokeKeyConfirmOpen] = useState(false)
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([])
  const [sendingInvite, setSendingInvite] = useState(false)
  const [inviteForm, setInviteForm] = useState<MemberForm>({ email: '', role: 'member' })

  // ICP
  const [icp, setIcp] = useState<IcpConfig | null>(null)
  const [icpForm, setIcpForm] = useState<IcpForm>({ targetIndustries: '', targetGeos: '', minEmployees: '', maxEmployees: '', mustHaveEmail: false })
  const [savingIcp, setSavingIcp] = useState(false)

  // Email config
  const emptyEmail: EmailConfigForm = { smtpHost: '', smtpPort: '587', smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', imapHost: '', imapPort: '993', imapSecure: true, imapUser: '', imapPass: '', smtpPassSet: false, imapPassSet: false }
  const [emailForm, setEmailForm] = useState<EmailConfigForm>(emptyEmail)
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
  const [warmup, setWarmup] = useState<WarmupStatus | null>(null)
  const [reputation, setReputation] = useState<ReputationVerdict | null>(null)
  const [startingWarmup, setStartingWarmup] = useState(false)

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

  // Domain-warmup ramp status + sender-reputation verdict, for the Deliverability
  // section. Refetched by loadDeliverability() below whenever the underlying state
  // may have changed (workspace switch, or right after starting warmup).
  const loadDeliverability = React.useCallback((workspaceId: string) => {
    let cancelled = false
    api<Partial<ReputationVerdict> & { warmup?: WarmupStatus }>(`/api/stats/reputation?workspaceId=${workspaceId}`)
      .then(d => {
        if (cancelled) return
        // Defensively require the shape this endpoint actually returns — a mocked
        // or unexpected `{}` response should render "no data" rather than a
        // half-populated card.
        if (d && typeof d.totalSends === 'number' && d.warmup) {
          const { warmup: w, ...rest } = d
          setReputation(rest as ReputationVerdict)
          setWarmup(w)
        } else {
          setReputation(null)
          setWarmup(null)
        }
      })
      .catch(() => { if (!cancelled) { setReputation(null); setWarmup(null) } })
    return () => { cancelled = true }
  }, [api])

  useEffect(() => {
    if (!workspace) return
    return loadDeliverability(workspace.id)
  }, [workspace?.id, loadDeliverability])

  async function startWarmup() {
    if (!workspace) return
    setStartingWarmup(true)
    try {
      await route('POST /api/workspaces/:id/warmup/start', { params: { id: workspace.id } })
      toast.success('Warmup started')
      loadDeliverability(workspace.id)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to start warmup') }
    finally { setStartingWarmup(false) }
  }

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

  function resendVerification() {
    route('POST /api/auth/resend-verification').then(() => toast.success('Verification email sent')).catch(() => toast.error('Failed to send'))
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
    if (!workspace) return
    setRemovingMemberId(userId)
    try {
      await route('DELETE /api/workspaces/:id/members/:userId', { params: { id: workspace.id, userId } })
      setMembers(prev => prev.filter(m => m.user.id !== userId))
      toast.success('Member removed')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to remove member') }
    finally { setRemovingMemberId(null); setRemoveMemberTarget(null) }
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
    if (!workspace) return
    setKeyWorking(true)
    try {
      await route('DELETE /api/workspaces/:id/api-key', { params: { id: workspace.id } })
      setHasKey(false)
      toast.success('API key revoked')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to revoke key') }
    finally { setKeyWorking(false); setRevokeKeyConfirmOpen(false) }
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
      <ProfileSection
        user={user}
        name={profileForm.name}
        onNameChange={name => setProfileForm({ name })}
        saving={savingProfile}
        onSave={saveProfile}
        onResendVerification={resendVerification}
      />

      <PasswordSection
        passwordForm={passwordForm}
        setPasswordForm={setPasswordForm}
        saving={savingPassword}
        onSave={changePassword}
      />

      {/* Security / Two-factor authentication */}
      <MfaSettings
        api={api}
        enabled={!!user.totpEnabled}
        onEnabledChange={(totpEnabled) => onUserUpdate({ ...user, totpEnabled })}
        toast={toast}
      />

      {workspace && (
        <WorkspaceSection wsForm={wsForm} setWsForm={setWsForm} saving={savingWs} onSave={saveWorkspace} />
      )}

      {workspace && (
        <TeamSection
          members={members}
          membersLoading={membersLoading}
          isOwnerOrAdmin={isOwnerOrAdmin}
          memberForm={memberForm}
          setMemberForm={setMemberForm}
          addingMember={addingMember}
          onAddMember={addMember}
          removingMemberId={removingMemberId}
          removeMemberTarget={removeMemberTarget}
          onRemoveRequest={setRemoveMemberTarget}
          onCloseRemoveModal={() => setRemoveMemberTarget(null)}
          onConfirmRemove={() => removeMemberTarget && removeMember(removeMemberTarget.user.id)}
          pendingInvites={pendingInvites}
          inviteForm={inviteForm}
          setInviteForm={setInviteForm}
          sendingInvite={sendingInvite}
          onSendInvite={sendInvite}
          onCancelInvite={cancelInvite}
        />
      )}

      {workspace && isOwnerOrAdmin && (
        <AccessReviewSection api={api} workspaceId={workspace.id} toast={toast} />
      )}

      {workspace && (
        <IcpSection icpForm={icpForm} setIcpForm={setIcpForm} saving={savingIcp} onSave={saveIcp} />
      )}

      {workspace && isOwnerOrAdmin && (
        <EmailConfigSection emailForm={emailForm} setEmailForm={setEmailForm} saving={savingEmail} onSave={saveEmailConfig} />
      )}

      {workspace && canManage && (
        <ErrorBoundary fallback={() => (
          <div style={{ ...s.card, color: colors.textMuted, fontSize: 13 }}>
            Compliance panel unavailable right now — the rest of Settings is unaffected.
          </div>
        )}>
          <CompliancePanel api={api} workspace={workspace} toast={toast} canManage={canManage} />
        </ErrorBoundary>
      )}

      {workspace && (
        <DeliverabilitySection
          smtpFromConfigured={!!emailForm.smtpFrom}
          domainCheck={domainCheck}
          domainCheckLoading={domainCheckLoading}
          suppressionCount={suppressionCount}
          dailySendLimit={icp?.dailySendLimit}
          approvalMode={icp?.approvalMode}
          warmup={warmup}
          reputation={reputation}
          canManage={isOwnerOrAdmin}
          startingWarmup={startingWarmup}
          onStartWarmup={startWarmup}
        />
      )}

      {workspace && (
        <ApiKeysSection
          hasKey={hasKey}
          keyWorking={keyWorking}
          onGenerate={generateApiKey}
          onRevokeRequest={() => setRevokeKeyConfirmOpen(true)}
          revokeKeyConfirmOpen={revokeKeyConfirmOpen}
          onCloseRevokeModal={() => setRevokeKeyConfirmOpen(false)}
          onConfirmRevoke={revokeApiKey}
          newKeyModal={newKeyModal}
          keyCopied={keyCopied}
          onCopyKey={copyKey}
          onCloseKeyModal={() => { setNewKeyModal(null); setKeyCopied(false) }}
        />
      )}

      {workspace && <WorkspaceInfoSection workspace={workspace} />}
    </div>
  )
}

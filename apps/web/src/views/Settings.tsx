import React, { useState, useEffect } from 'react'
import type { User, Workspace, WorkspaceMember } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type IcpConfig = {
  targetIndustries: string[]
  targetGeos: string[]
  minEmployees: number | null
  maxEmployees: number | null
  mustHaveEmail: boolean
}

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

  // Team
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberForm, setMemberForm] = useState({ email: '', role: 'member' })
  const [addingMember, setAddingMember] = useState(false)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)

  // ICP
  const [icp, setIcp] = useState<IcpConfig | null>(null)
  const [icpForm, setIcpForm] = useState({ targetIndustries: '', targetGeos: '', minEmployees: '', maxEmployees: '', mustHaveEmail: false })
  const [savingIcp, setSavingIcp] = useState(false)

  // API Keys
  const [keyWorking, setKeyWorking] = useState(false)
  const [newKeyModal, setNewKeyModal] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [hasKey, setHasKey] = useState(!!workspace?.ingestApiKey)

  useEffect(() => {
    setHasKey(!!workspace?.ingestApiKey)
  }, [workspace?.ingestApiKey])

  useEffect(() => {
    if (!workspace) return
    setMembersLoading(true)
    api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`)
      .then(d => setMembers(d.members || []))
      .catch(() => {})
      .finally(() => setMembersLoading(false))
    api<{ icp: IcpConfig | null }>(`/api/workspaces/${workspace.id}/icp`)
      .then(d => {
        if (d.icp) {
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

  async function addMember() {
    if (!workspace || !memberForm.email.trim()) return
    setAddingMember(true)
    try {
      const d = await api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: memberForm.email.trim(), role: memberForm.role })
      })
      setMembers(d.members || [])
      setMemberForm({ email: '', role: 'member' })
      toast.success('Member added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add member') }
    finally { setAddingMember(false) }
  }

  async function removeMember(userId: string) {
    if (!workspace || !confirm('Remove this member?')) return
    setRemovingMemberId(userId)
    try {
      const d = await api<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members/${userId}`, {
        method: 'DELETE'
      })
      setMembers(d.members || [])
      toast.success('Member removed')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to remove member') }
    finally { setRemovingMemberId(null) }
  }

  async function saveIcp() {
    if (!workspace) return
    setSavingIcp(true)
    try {
      const d = await api<{ icp: IcpConfig }>(`/api/workspaces/${workspace.id}/icp`, {
        method: 'PUT',
        body: JSON.stringify({
          targetIndustries: icpForm.targetIndustries.split(',').map(s => s.trim()).filter(Boolean),
          targetGeos: icpForm.targetGeos.split(',').map(s => s.trim()).filter(Boolean),
          minEmployees: icpForm.minEmployees ? parseInt(icpForm.minEmployees, 10) : null,
          maxEmployees: icpForm.maxEmployees ? parseInt(icpForm.maxEmployees, 10) : null,
          mustHaveEmail: icpForm.mustHaveEmail,
        })
      })
      setIcp(d.icp)
      toast.success('ICP settings saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save ICP') }
    finally { setSavingIcp(false) }
  }

  async function generateApiKey() {
    if (!workspace) return
    setKeyWorking(true)
    try {
      const d = await api<{ key: string }>(`/api/workspaces/${workspace.id}/api-key/rotate`, { method: 'POST' })
      setNewKeyModal(d.key)
      setHasKey(true)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to generate key') }
    finally { setKeyWorking(false) }
  }

  async function revokeApiKey() {
    if (!workspace || !confirm('Revoke this API key? All integrations using it will stop working.')) return
    setKeyWorking(true)
    try {
      await api(`/api/workspaces/${workspace.id}/api-key`, { method: 'DELETE' })
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

  const myMembership = members.find(m => m.user.id === user.id)
  const isOwnerOrAdmin = myMembership?.role === 'owner' || myMembership?.role === 'admin'

  return (
    <div style={s.stack}>
      {/* API Key modal */}
      {newKeyModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200
        }}>
          <div style={{ ...s.card, maxWidth: 480, width: '90%' }}>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <label style={s.label}>Email</label>
                    <input
                      style={{ ...s.input, width: 220 }}
                      placeholder="colleague@company.com"
                      value={memberForm.email}
                      onChange={e => setMemberForm(f => ({ ...f, email: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={s.label}>Role</label>
                    <select
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
              <label style={s.label}>Target Industries (comma-separated)</label>
              <input
                style={s.input}
                placeholder="e.g. HVAC, Electrical, Plumbing"
                value={icpForm.targetIndustries}
                onChange={e => setIcpForm(f => ({ ...f, targetIndustries: e.target.value }))}
              />
            </div>
            <div>
              <label style={s.label}>Target Geographies (comma-separated)</label>
              <input
                style={s.input}
                placeholder="e.g. Brisbane, Sydney, Melbourne"
                value={icpForm.targetGeos}
                onChange={e => setIcpForm(f => ({ ...f, targetGeos: e.target.value }))}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={s.label}>Min Employees</label>
                <input
                  style={s.input}
                  type="number"
                  min="0"
                  placeholder="e.g. 5"
                  value={icpForm.minEmployees}
                  onChange={e => setIcpForm(f => ({ ...f, minEmployees: e.target.value }))}
                />
              </div>
              <div>
                <label style={s.label}>Max Employees</label>
                <input
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

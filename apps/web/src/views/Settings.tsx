import React, { useEffect, useState } from 'react'
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

type ProductForm = {
  productName: string
  productCategory: string
  targetICP: string
  keyPainPoints: string
  differentiators: string
  ctaType: string
  calendarUrl: string
  sendLimitPerDay: number
}

const EMPTY_PRODUCT: ProductForm = {
  productName: '', productCategory: '', targetICP: '',
  keyPainPoints: '', differentiators: '',
  ctaType: 'book_call', calendarUrl: '',
  sendLimitPerDay: 50,
}

type Suppression = {
  id: string
  email: string
  reason: string
  suppressedAt: string
}


export function Settings({ api, user, workspace, toast, onUserUpdate, onWorkspaceUpdate }: Props) {
  const [profileForm, setProfileForm] = useState({ name: user.name ?? '' })
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [wsForm, setWsForm] = useState({ name: workspace?.name ?? '', slug: workspace?.slug ?? '' })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingWs, setSavingWs] = useState(false)
  const [productForm, setProductForm] = useState<ProductForm>(EMPTY_PRODUCT)
  const [savingProduct, setSavingProduct] = useState(false)
  const [suppressions, setSuppressions] = useState<Suppression[]>([])
  const [loadingSuppressions, setLoadingSuppressions] = useState(false)
  const [removingSuppressionId, setRemovingSuppressionId] = useState<string | null>(null)
  const [pendingReviewCount, setPendingReviewCount] = useState<number | null>(null)

  useEffect(() => {
    if (!workspace) return
    api<{ workspaceProduct: ProductForm | null }>(`/api/workspaces/${workspace.id}/product`)
      .then(d => {
        if (d.workspaceProduct) {
          const p = d.workspaceProduct as Record<string, unknown>
          setProductForm({
            productName: String(p.productName ?? ''),
            productCategory: String(p.productCategory ?? ''),
            targetICP: String(p.targetICP ?? ''),
            keyPainPoints: Array.isArray(p.keyPainPoints) ? (p.keyPainPoints as string[]).join('\n') : String(p.keyPainPoints ?? ''),
            differentiators: Array.isArray(p.differentiators) ? (p.differentiators as string[]).join('\n') : String(p.differentiators ?? ''),
            ctaType: String(p.ctaType ?? 'book_call'),
            calendarUrl: String(p.calendarUrl ?? ''),
            sendLimitPerDay: typeof p.sendLimitPerDay === 'number' ? p.sendLimitPerDay : 50,
          })
        }
      })
      .catch(() => {})
  }, [workspace?.id])

  useEffect(() => {
    if (!workspace) return
    setLoadingSuppressions(true)
    api<{ suppressions: Suppression[] }>(`/api/workspaces/${workspace.id}/suppressions`)
      .then(d => setSuppressions(d.suppressions))
      .catch(() => {})
      .finally(() => setLoadingSuppressions(false))
  }, [workspace?.id])

  useEffect(() => {
    if (!workspace) return
    api<{ count: number }>(`/api/workspaces/${workspace.id}/pending-reviews`)
      .then(d => setPendingReviewCount(d.count))
      .catch(() => {})
  }, [workspace?.id])

  async function removeSuppression(id: string) {
    if (!workspace) return
    setRemovingSuppressionId(id)
    try {
      await api(`/api/workspaces/${workspace.id}/suppressions/${id}`, { method: 'DELETE' })
      setSuppressions(prev => prev.filter(s => s.id !== id))
      toast.success('Suppression removed')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Remove failed') }
    finally { setRemovingSuppressionId(null) }
  }

  async function saveProduct() {
    if (!workspace) return
    setSavingProduct(true)
    try {
      await api(`/api/workspaces/${workspace.id}/product`, {
        method: 'PUT',
        body: JSON.stringify({
          productName: productForm.productName.trim(),
          productCategory: productForm.productCategory.trim() || null,
          targetICP: productForm.targetICP.trim() || null,
          keyPainPoints: productForm.keyPainPoints.split('\n').map(l => l.trim()).filter(Boolean),
          differentiators: productForm.differentiators.split('\n').map(l => l.trim()).filter(Boolean),
          ctaType: productForm.ctaType,
          calendarUrl: productForm.calendarUrl.trim() || null,
          sendLimitPerDay: productForm.sendLimitPerDay,
        })
      })
      toast.success('Product context saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') }
    finally { setSavingProduct(false) }
  }

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

      {/* Product context */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Product Context</div>
          <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 16 }}>
            Used by AI to personalise outreach and research. All fields optional except Product Name.
          </div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 480, marginBottom: 16 }}>
            <div>
              <label style={s.label}>Product Name <span style={{ color: colors.red }}>*</span></label>
              <input style={s.input} value={productForm.productName}
                onChange={e => setProductForm(f => ({ ...f, productName: e.target.value }))}
                placeholder="e.g. Acme Field Ops" />
            </div>
            <div>
              <label style={s.label}>Product Category</label>
              <input style={s.input} value={productForm.productCategory}
                onChange={e => setProductForm(f => ({ ...f, productCategory: e.target.value }))}
                placeholder="e.g. Field Service Management" />
            </div>
            <div>
              <label style={s.label}>Target ICP</label>
              <input style={s.input} value={productForm.targetICP}
                onChange={e => setProductForm(f => ({ ...f, targetICP: e.target.value }))}
                placeholder="e.g. Trades businesses with 10–200 employees" />
            </div>
            <div>
              <label style={s.label}>Key Pain Points (one per line)</label>
              <textarea style={{ ...s.textarea, minHeight: 72 }} value={productForm.keyPainPoints}
                onChange={e => setProductForm(f => ({ ...f, keyPainPoints: e.target.value }))}
                placeholder={'scheduling\ndispatching\ninvoicing'} />
            </div>
            <div>
              <label style={s.label}>Differentiators (one per line)</label>
              <textarea style={{ ...s.textarea, minHeight: 72 }} value={productForm.differentiators}
                onChange={e => setProductForm(f => ({ ...f, differentiators: e.target.value }))}
                placeholder={'mobile-first\neasy onboarding'} />
            </div>
            <div>
              <label style={s.label}>Call-to-Action Type</label>
              <select style={{ ...s.input, cursor: 'pointer' }} value={productForm.ctaType}
                onChange={e => setProductForm(f => ({ ...f, ctaType: e.target.value }))}>
                <option value="book_call">Book a Call</option>
                <option value="demo">Request a Demo</option>
                <option value="free_trial">Start Free Trial</option>
                <option value="contact">Contact Us</option>
              </select>
            </div>
            {productForm.ctaType === 'book_call' && (
              <div>
                <label style={s.label}>Calendar URL</label>
                <input style={s.input} value={productForm.calendarUrl}
                  onChange={e => setProductForm(f => ({ ...f, calendarUrl: e.target.value }))}
                  placeholder="https://calendly.com/yourname/30min" />
              </div>
            )}
            <div>
              <label style={s.label}>Daily Email Send Limit</label>
              <input
                style={s.input}
                type="number"
                min={1}
                max={500}
                value={productForm.sendLimitPerDay}
                onChange={e => setProductForm(f => ({ ...f, sendLimitPerDay: Math.max(1, Math.min(500, parseInt(e.target.value) || 1)) }))}
              />
              <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
                Maximum emails sent per day across all cadences
              </div>
            </div>
          </div>
          <button style={s.btn} disabled={savingProduct || !productForm.productName.trim()} onClick={saveProduct}>
            {savingProduct ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Product Context'}
          </button>
        </div>
      )}

      {/* Email Suppressions */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Email Suppressions</div>
          <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 16 }}>
            Contacts who unsubscribe from personalised brief pages will appear here.
          </div>
          {loadingSuppressions ? (
            <div style={{ textAlign: 'center', padding: 20 }}><Spinner /></div>
          ) : suppressions.length === 0 ? (
            <div style={{ ...s.cardInner, color: colors.textFaint, fontSize: 13, textAlign: 'center', padding: 20 }}>
              No suppressed emails — contacts who unsubscribe from personalised brief pages will appear here.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Email', 'Reason', 'Suppressed', ''].map(h => (
                      <th key={h} style={{
                        textAlign: 'left', color: colors.textFaint, fontSize: 11, fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                        padding: '6px 10px', borderBottom: `1px solid ${colors.border}`
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {suppressions.map(sup => (
                    <tr key={sup.id}>
                      <td style={{ padding: '8px 10px', color: colors.text }}>{sup.email}</td>
                      <td style={{ padding: '8px 10px', color: colors.textMuted }}>{sup.reason || '—'}</td>
                      <td style={{ padding: '8px 10px', color: colors.textFaint, fontSize: 12 }}>
                        {new Date(sup.suppressedAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <button
                          style={s.btnDanger}
                          disabled={removingSuppressionId === sup.id}
                          onClick={() => removeSuppression(sup.id)}
                        >
                          {removingSuppressionId === sup.id ? '…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pending Review Queue */}
      {workspace && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Pending Review Queue</div>
          {pendingReviewCount === null ? (
            <div style={{ textAlign: 'center', padding: 16 }}><Spinner /></div>
          ) : pendingReviewCount === 0 ? (
            <div style={{ color: colors.textFaint, fontSize: 13 }}>No emails pending review.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                background: colors.amber + '22', color: colors.amber,
                padding: '4px 12px', borderRadius: 99, fontSize: 13, fontWeight: 700
              }}>
                {pendingReviewCount} outreach email{pendingReviewCount !== 1 ? 's' : ''} awaiting your approval
              </span>
              <span style={{ color: colors.textFaint, fontSize: 12 }}>
                Go to Intelligence &gt; Cadences tab to review
              </span>
            </div>
          )}
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

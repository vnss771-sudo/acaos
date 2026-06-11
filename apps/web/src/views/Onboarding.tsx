import React, { useState } from 'react'
import type { Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace
  toast: ToastHook
  onComplete: () => void
}

type Step = 1 | 2 | 3

const DOT_STYLE = (active: boolean): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%',
  background: active ? colors.blue : colors.border,
  transition: 'background 0.2s',
})

export function Onboarding({ api, workspace, toast, onComplete }: Props) {
  const [step, setStep]   = useState<Step>(1)
  const [saving, setSaving] = useState(false)

  // Step 1 — Product
  const [productName,     setProductName]     = useState('')
  const [painPoints,      setPainPoints]      = useState('')
  const [differentiators, setDifferentiators] = useState('')
  const [ctaType,         setCtaType]         = useState('book_call')
  const [calendarUrl,     setCalendarUrl]     = useState('')

  // Step 2 — ICP
  const [targetIndustries, setTargetIndustries] = useState('')
  const [minEmployees,     setMinEmployees]     = useState('')
  const [maxEmployees,     setMaxEmployees]     = useState('')
  const [mustHaveEmail,    setMustHaveEmail]    = useState(false)

  // Step 3 — First prospect
  const [companyName,  setCompanyName]  = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactName,  setContactName]  = useState('')
  const [industry,     setIndustry]     = useState('')
  const [domain,       setDomain]       = useState('')

  async function handleStep1() {
    if (!productName.trim()) { toast.error('Product name is required'); return }
    setSaving(true)
    try {
      await api(`/api/workspaces/${workspace.id}/product`, {
        method: 'PUT',
        body: JSON.stringify({
          productName: productName.trim(),
          keyPainPoints: painPoints.split('\n').map(l => l.trim()).filter(Boolean),
          differentiators: differentiators.split('\n').map(l => l.trim()).filter(Boolean),
          ctaType,
          calendarUrl: calendarUrl.trim() || null,
        }),
      })
      setStep(2)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  async function handleStep2() {
    setSaving(true)
    try {
      const industries = targetIndustries.split(',').map(s => s.trim()).filter(Boolean)
      await api(`/api/workspaces/${workspace.id}/icp`, {
        method: 'PUT',
        body: JSON.stringify({
          targetIndustries: industries,
          minEmployees: minEmployees ? Number(minEmployees) : null,
          maxEmployees: maxEmployees ? Number(maxEmployees) : null,
          mustHaveEmail,
          targetGeos: [],
        }),
      })
      setStep(3)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  async function handleStep3() {
    if (!companyName.trim()) { toast.error('Company name is required'); return }
    setSaving(true)
    try {
      await api('/api/prospects', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: workspace.id,
          companyName: companyName.trim(),
          contactEmail: contactEmail.trim() || null,
          contactName: contactName.trim() || null,
          industry: industry.trim() || null,
          domain: domain.trim() || null,
        }),
      })
      onComplete()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add prospect') }
    finally { setSaving(false) }
  }

  return (
    <div style={{
      minHeight: '100vh', background: colors.bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
    }}>
      <div style={{ width: '100%', maxWidth: 520 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: colors.text, marginBottom: 6 }}>
            Welcome to ACAOS
          </div>
          <div style={{ color: colors.textFaint, fontSize: 14 }}>
            Your buying-window intelligence engine
          </div>
          {/* Progress dots */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20 }}>
            {([1, 2, 3] as Step[]).map(n => (
              <div key={n} style={DOT_STYLE(step >= n)} />
            ))}
          </div>
          <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 8 }}>
            Step {step} of 3
          </div>
        </div>

        <div style={{ ...s.card, padding: 28 }}>
          {/* Step 1 — Product */}
          {step === 1 && (
            <div style={s.stack}>
              <div style={{ color: colors.textMuted, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
                What are you selling?
              </div>
              <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 8 }}>
                ACAOS uses this to personalise every outreach email and opportunity brief.
              </div>
              <div>
                <label style={s.label}>Product Name <span style={{ color: colors.red }}>*</span></label>
                <input style={s.input} value={productName} onChange={e => setProductName(e.target.value)}
                  placeholder="e.g. Acme Field Ops" autoFocus />
              </div>
              <div>
                <label style={s.label}>Key Pain Points (one per line)</label>
                <textarea style={{ ...s.textarea, minHeight: 80 }} value={painPoints}
                  onChange={e => setPainPoints(e.target.value)}
                  placeholder={'scheduling\ndispatching\ninvoicing'} />
              </div>
              <div>
                <label style={s.label}>Differentiators (one per line)</label>
                <textarea style={{ ...s.textarea, minHeight: 64 }} value={differentiators}
                  onChange={e => setDifferentiators(e.target.value)}
                  placeholder={'mobile-first\neasy onboarding\nno setup fees'} />
              </div>
              <div>
                <label style={s.label}>Call-to-Action</label>
                <select style={{ ...s.input, cursor: 'pointer' }} value={ctaType}
                  onChange={e => setCtaType(e.target.value)}>
                  <option value="book_call">Book a Call</option>
                  <option value="demo">Request a Demo</option>
                  <option value="free_trial">Start Free Trial</option>
                  <option value="contact">Contact Us</option>
                </select>
              </div>
              {ctaType === 'book_call' && (
                <div>
                  <label style={s.label}>Calendar URL</label>
                  <input style={s.input} value={calendarUrl} onChange={e => setCalendarUrl(e.target.value)}
                    placeholder="https://calendly.com/yourname/30min" />
                </div>
              )}
              <button style={s.btn} onClick={handleStep1} disabled={saving || !productName.trim()}>
                {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Next →'}
              </button>
            </div>
          )}

          {/* Step 2 — ICP */}
          {step === 2 && (
            <div style={s.stack}>
              <div style={{ color: colors.textMuted, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
                Who is your ideal customer?
              </div>
              <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 8 }}>
                Used to score and rank prospects. You can refine this later.
              </div>
              <div>
                <label style={s.label}>Target Industries (comma separated)</label>
                <input style={s.input} value={targetIndustries}
                  onChange={e => setTargetIndustries(e.target.value)}
                  placeholder="construction, logistics, trades, recruitment" autoFocus />
              </div>
              <div style={s.grid2}>
                <div>
                  <label style={s.label}>Min Employees</label>
                  <input style={s.input} type="number" min={1} value={minEmployees}
                    onChange={e => setMinEmployees(e.target.value)} placeholder="10" />
                </div>
                <div>
                  <label style={s.label}>Max Employees</label>
                  <input style={s.input} type="number" min={1} value={maxEmployees}
                    onChange={e => setMaxEmployees(e.target.value)} placeholder="500" />
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: colors.textMuted, fontSize: 13 }}>
                <input type="checkbox" checked={mustHaveEmail} onChange={e => setMustHaveEmail(e.target.checked)} />
                Only target prospects with a known contact email
              </label>
              <button style={s.btn} onClick={handleStep2} disabled={saving}>
                {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Next →'}
              </button>
            </div>
          )}

          {/* Step 3 — First prospect */}
          {step === 3 && (
            <div style={s.stack}>
              <div style={{ color: colors.textMuted, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
                Add your first prospect
              </div>
              <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 8 }}>
                ACAOS will score them instantly and show you the buying-window intelligence.
              </div>
              <div>
                <label style={s.label}>Company Name <span style={{ color: colors.red }}>*</span></label>
                <input style={s.input} value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="e.g. Apex Electrical Services" autoFocus />
              </div>
              <div style={s.grid2}>
                <div>
                  <label style={s.label}>Contact Name</label>
                  <input style={s.input} value={contactName} onChange={e => setContactName(e.target.value)}
                    placeholder="e.g. James Miller" />
                </div>
                <div>
                  <label style={s.label}>Contact Email</label>
                  <input style={s.input} type="email" value={contactEmail}
                    onChange={e => setContactEmail(e.target.value)} placeholder="james@apex.com" />
                </div>
              </div>
              <div style={s.grid2}>
                <div>
                  <label style={s.label}>Industry</label>
                  <input style={s.input} value={industry} onChange={e => setIndustry(e.target.value)}
                    placeholder="e.g. construction" />
                </div>
                <div>
                  <label style={s.label}>Website / Domain</label>
                  <input style={s.input} value={domain} onChange={e => setDomain(e.target.value)}
                    placeholder="apex.com.au" />
                </div>
              </div>
              <button style={s.btn} onClick={handleStep3} disabled={saving || !companyName.trim()}>
                {saving ? <><Spinner size={14} color="#fff" /> Adding…</> : "Let's Go →"}
              </button>
              <button
                style={{ ...s.btnGhost, textAlign: 'center', width: '100%', marginTop: 4 }}
                onClick={onComplete}
              >
                Skip for now
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

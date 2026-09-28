import React, { useState, useMemo } from 'react'
import type { SeedWorkspaceRequest, UpdateIcpRequest } from '@acaos/shared'
import { makeRouteApi } from '../lib/routeApi.js'
import { colors, s } from '../styles.js'
import { Grid } from './ui/Grid.js'
import type { Workspace } from '../types.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { PLAYBOOKS, type Playbook } from '../lib/playbooks.js'

type Props = {
  workspace: Workspace
  api: ApiHook
  toast: ToastHook
  onComplete: () => void
  // Optional: finish onboarding and jump straight to email setup — the one step
  // still required before anything can be sent.
  onConnectEmail?: () => void
}

type IcpForm = {
  businessType: string
  targetIndustries: string
  targetGeos: string
  outreachTone: string
  dailySendLimit: number
  approvalMode: boolean
}

function defaultIcpForm(playbook: Playbook): IcpForm {
  return {
    businessType: playbook.label,
    targetIndustries: playbook.icp.targetIndustries.join('\n'),
    targetGeos: playbook.icp.targetGeos.join('\n'),
    outreachTone: playbook.icp.outreachTone,
    dailySendLimit: playbook.icp.dailySendLimit,
    approvalMode: true
  }
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.85)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  overflowY: 'auto'
}

const cardStyle: React.CSSProperties = {
  maxWidth: 560,
  width: '100%',
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: 16,
  padding: 32,
  position: 'relative'
}

const hintStyle: React.CSSProperties = { color: colors.textFaint, fontSize: 12, marginTop: 4, lineHeight: 1.4 }

// The whole product in four plain-language steps. Shown up front so a new user
// knows what the setup they're about to do is *for* before being asked anything.
const HOW_IT_WORKS = [
  { icon: '◎', title: 'Find', text: 'We surface companies that match who you sell to.' },
  { icon: '✎', title: 'Draft', text: 'AI writes a personalised first email for each one.' },
  { icon: '✓', title: 'Approve', text: 'You review and approve — nothing sends without you.' },
  { icon: '✉', title: 'Reply', text: 'Replies are sorted by intent so you know who to call.' },
]

const STEP_LABELS = ['Pick your business type', 'Who do you want to reach?', 'Add example data']

// One progress indicator for the three setup steps; the final "done" screen has none.
function StepProgress({ current }: { current: number }) {
  const total = STEP_LABELS.length
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
        Step {current} of {total} · {STEP_LABELS[current - 1]}
      </div>
      <div style={{ height: 4, background: colors.border, borderRadius: 2, overflow: 'hidden', width: '100%' }}>
        <div style={{ height: '100%', background: colors.blue, width: `${(current / total) * 100}%`, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  )
}

export function OnboardingWizard({ workspace, api, toast, onComplete, onConnectEmail }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [step, setStep] = useState(1)
  const [selectedPlaybook, setSelectedPlaybook] = useState<Playbook | null>(null)
  const [icpForm, setIcpForm] = useState<IcpForm>({
    businessType: '',
    targetIndustries: '',
    targetGeos: '',
    outreachTone: 'professional',
    dailySendLimit: 50,
    approvalMode: true
  })
  // What was actually set up, so the final screen only claims what really happened.
  const [examplesAdded, setExamplesAdded] = useState(false)
  const [saving, setSaving] = useState(false)

  function selectPlaybook(pb: Playbook) {
    setSelectedPlaybook(pb)
    setIcpForm(defaultIcpForm(pb))
    setStep(2)
  }

  async function handleSkipSetup() {
    try {
      setSaving(true)
      const body: SeedWorkspaceRequest = { playbookId: null, includeExamples: false }
      await route('POST /api/workspaces/:id/seed', { params: { id: workspace.id }, body })
      onComplete()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to skip setup')
    } finally {
      setSaving(false)
    }
  }

  async function handleStep2Continue() {
    try {
      setSaving(true)
      const icpBody: UpdateIcpRequest = {
        businessType: icpForm.businessType,
        playbook: selectedPlaybook?.id ?? null,
        targetIndustries: icpForm.targetIndustries.split('\n').map(s => s.trim()).filter(Boolean),
        targetGeos: icpForm.targetGeos.split('\n').map(s => s.trim()).filter(Boolean),
        minEmployees: null,
        maxEmployees: null,
        mustHaveEmail: false,
        outreachTone: icpForm.outreachTone,
        dailySendLimit: icpForm.dailySendLimit,
        approvalMode: icpForm.approvalMode,
        excludedIndustries: []
      }
      await route('PUT /api/workspaces/:id/icp', { params: { id: workspace.id }, body: icpBody })
      setStep(3)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save your targeting settings')
    } finally {
      setSaving(false)
    }
  }

  async function handleStep3Continue(includeExamples: boolean) {
    try {
      setSaving(true)
      const body: SeedWorkspaceRequest = { playbookId: selectedPlaybook?.id ?? null, includeExamples }
      await route('POST /api/workspaces/:id/seed', { params: { id: workspace.id }, body })
      setExamplesAdded(includeExamples)
      setStep(4)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to finish setup')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Workspace setup">
      <div style={cardStyle}>
        {step <= 3 && <StepProgress current={step} />}

        {step === 1 && (
          <Step1 onSelect={selectPlaybook} onSkip={handleSkipSetup} saving={saving} />
        )}
        {step === 2 && selectedPlaybook && (
          <Step2
            form={icpForm}
            onChange={setIcpForm}
            onBack={() => setStep(1)}
            onContinue={handleStep2Continue}
            saving={saving}
          />
        )}
        {step === 3 && selectedPlaybook && (
          <Step3
            playbook={selectedPlaybook}
            onContinue={() => handleStep3Continue(true)}
            onSkip={() => handleStep3Continue(false)}
            saving={saving}
          />
        )}
        {step === 4 && (
          <Step4
            examplesAdded={examplesAdded}
            approvalMode={icpForm.approvalMode}
            onComplete={onComplete}
            onConnectEmail={onConnectEmail}
          />
        )}
      </div>
    </div>
  )
}

function Step1({
  onSelect,
  onSkip,
  saving
}: {
  onSelect: (pb: Playbook) => void
  onSkip: () => void
  saving: boolean
}) {
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <h1 style={{ color: colors.text, fontSize: 22, fontWeight: 700, margin: '0 0 10px' }}>
          Welcome to ACAOS
        </h1>
        <p style={{ color: colors.textMuted, fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          ACAOS helps you win new clients by email. Here's how it works:
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 24 }}>
        {HOW_IT_WORKS.map((h, i) => (
          <div key={h.title} style={{ background: colors.bgElevated, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12 }}>
            <div style={{ color: colors.blueLight, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
              <span aria-hidden="true">{h.icon}</span> {i + 1}. {h.title}
            </div>
            <div style={{ color: colors.textMuted, fontSize: 12, lineHeight: 1.4 }}>{h.text}</div>
          </div>
        ))}
      </div>

      <div style={{ color: colors.text, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        What kind of business are you?
      </div>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
        Pick the closest match. We'll pre-fill sensible targeting for you — you can change all of it on the next step or later in Settings.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        {PLAYBOOKS.map(pb => (
          <div
            key={pb.id}
            style={{
              background: colors.bgElevated,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 16,
              transition: 'border-color 0.15s'
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = colors.blue)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = colors.border)}
          >
            <div aria-hidden="true" style={{ fontSize: 28, marginBottom: 8 }}>{pb.icon}</div>
            <div style={{ color: colors.text, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
              {pb.label}
            </div>
            <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>
              {pb.description}
            </div>
            <button
              style={{ ...s.btn, fontSize: 13, padding: '7px 14px' }}
              onClick={() => onSelect(pb)}
              disabled={saving}
              aria-label={`Select ${pb.label}`}
            >
              Select →
            </button>
          </div>
        ))}
      </div>

      <div style={{ textAlign: 'center' }}>
        <p style={{ color: colors.textFaint, fontSize: 12, margin: '16px 0 8px' }}>
          None of these fit? Skip and set your targeting yourself in Settings.
        </p>
        <button
          onClick={onSkip}
          disabled={saving}
          style={{
            background: 'none',
            border: 'none',
            color: colors.blue,
            cursor: 'pointer',
            fontSize: 13,
            textDecoration: 'underline',
            fontWeight: 500
          }}
        >
          Skip setup →
        </button>
      </div>
    </div>
  )
}

function Step2({
  form,
  onChange,
  onBack,
  onContinue,
  saving
}: {
  form: IcpForm
  onChange: (f: IcpForm) => void
  onBack: () => void
  onContinue: () => void
  saving: boolean
}) {
  function set<K extends keyof IcpForm>(key: K, value: IcpForm[K]) {
    onChange({ ...form, [key]: value })
  }

  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 6px' }}>
        Who do you want to reach?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 24px', lineHeight: 1.5 }}>
        This is your ideal customer — the kinds of companies ACAOS should look for and write to.
        We've filled it in from your business type; adjust anything that doesn't fit.
      </p>

      <div style={{ ...s.stack, gap: 16 }}>
        <div>
          <label style={{ ...s.label }} htmlFor="onb-business-type">Your business</label>
          <input
            id="onb-business-type"
            style={{ ...s.input }}
            value={form.businessType}
            onChange={e => set('businessType', e.target.value)}
            placeholder="e.g. Industrial Services"
          />
          <div style={hintStyle}>What you sell — used to tailor the emails we draft for you.</div>
        </div>

        <div>
          <label style={{ ...s.label }} htmlFor="onb-industries">Industries you sell to (one per line)</label>
          <textarea
            id="onb-industries"
            style={{ ...s.textarea, minHeight: 80 }}
            value={form.targetIndustries}
            onChange={e => set('targetIndustries', e.target.value)}
            placeholder="Manufacturing&#10;Construction&#10;Mining"
          />
        </div>

        <div>
          <label style={{ ...s.label }} htmlFor="onb-geos">Locations you serve (one per line)</label>
          <textarea
            id="onb-geos"
            style={{ ...s.textarea, minHeight: 60 }}
            value={form.targetGeos}
            onChange={e => set('targetGeos', e.target.value)}
            placeholder="Brisbane&#10;Queensland&#10;Australia"
          />
        </div>

        <Grid cols={2}>
          <div>
            <label style={{ ...s.label }} htmlFor="onb-tone">Email tone</label>
            <select
              id="onb-tone"
              style={{ ...s.input }}
              value={form.outreachTone}
              onChange={e => set('outreachTone', e.target.value)}
            >
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="direct">Direct</option>
            </select>
            <div style={hintStyle}>How the AI-drafted emails should sound.</div>
          </div>
          <div>
            <label style={{ ...s.label }} htmlFor="onb-daily-limit">Max emails per day</label>
            <input
              id="onb-daily-limit"
              type="number"
              style={{ ...s.input }}
              value={form.dailySendLimit}
              min={1}
              max={500}
              onChange={e => set('dailySendLimit', Number(e.target.value))}
            />
            <div style={hintStyle}>Keeping this low protects your email reputation. 30–60 is a safe start.</div>
          </div>
        </Grid>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            background: colors.bgElevated,
            borderRadius: 8,
            border: `1px solid ${colors.border}`
          }}
        >
          <input
            id="approvalMode"
            type="checkbox"
            checked={form.approvalMode}
            onChange={e => set('approvalMode', e.target.checked)}
            style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer', accentColor: colors.blue }}
          />
          <label htmlFor="approvalMode" style={{ color: colors.text, fontSize: 14, cursor: 'pointer' }}>
            Require my approval before any email is sent
            <div style={{ ...hintStyle, marginTop: 2 }}>
              Recommended. Drafts wait in <strong>To Review</strong> until you approve them.
            </div>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 28, justifyContent: 'flex-end' }}>
        <button style={{ ...s.btnSecondary }} onClick={onBack} disabled={saving}>
          Back
        </button>
        <button style={{ ...s.btn }} onClick={onContinue} disabled={saving}>
          {saving ? 'Saving...' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}

function Step3({
  playbook,
  onContinue,
  onSkip,
  saving
}: {
  playbook: Playbook
  onContinue: () => void
  onSkip: () => void
  saving: boolean
}) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        Want some example data to explore?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
        We can add 3 example {playbook.label.toLowerCase()} target companies, each with buying signals and a
        suggested next step, so you can see how ACAOS works before adding your own.
      </p>

      <div
        style={{
          background: `${colors.blue}18`,
          border: `1px solid ${colors.blue}44`,
          borderRadius: 10,
          padding: '14px 16px',
          marginBottom: 24,
          color: colors.blueLight,
          fontSize: 13,
          lineHeight: 1.5
        }}
      >
        Examples are clearly labelled, and they drop out of your analytics as soon as you
        add a real company.
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={onSkip}
          disabled={saving}
          style={{
            background: 'none',
            border: 'none',
            color: colors.textFaint,
            cursor: 'pointer',
            fontSize: 13,
            textDecoration: 'underline'
          }}
        >
          No thanks, start empty
        </button>
        <button style={{ ...s.btn }} onClick={onContinue} disabled={saving}>
          {saving ? 'Setting up...' : 'Looks good — add examples'}
        </button>
      </div>
    </div>
  )
}

function Step4({
  examplesAdded,
  approvalMode,
  onComplete,
  onConnectEmail
}: {
  examplesAdded: boolean
  approvalMode: boolean
  onComplete: () => void
  onConnectEmail?: () => void
}) {
  // Only list what actually happened — no "✓ examples loaded" if they were skipped.
  const done = [
    'Targeting saved',
    ...(examplesAdded ? ['Example companies added'] : []),
    approvalMode ? 'Approval required before sending' : 'Emails can send without your approval',
  ]

  return (
    <div>
      <div style={{ textAlign: 'center' }}>
        <div aria-hidden="true" style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
        <h2 style={{ color: colors.text, fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>
          You're set up.
        </h2>
        <p style={{ color: colors.textMuted, fontSize: 14, margin: '0 0 20px' }}>
          One thing left before ACAOS can send emails for you.
        </p>
      </div>

      <div
        style={{
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: '8px 20px',
          marginBottom: 16
        }}
      >
        {done.map(item => (
          <div
            key={item}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
              borderBottom: `1px solid ${colors.border}`
            }}
          >
            <span style={{ color: colors.green, fontSize: 16, fontWeight: 700 }}>✓</span>
            <span style={{ color: colors.text, fontSize: 14 }}>{item}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0' }}>
          <span style={{ color: colors.amber, fontSize: 16, fontWeight: 700 }}>○</span>
          <div>
            <div style={{ color: colors.text, fontSize: 14 }}>Connect your email account</div>
            <div style={hintStyle}>
              So ACAOS can send from your address and pick up replies. Takes about 2 minutes.
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {onConnectEmail && (
          <button style={{ ...s.btn, fontSize: 15, padding: '12px 28px', width: '100%' }} onClick={onConnectEmail}>
            Connect my email now →
          </button>
        )}
        <button
          style={onConnectEmail
            ? { ...s.btnSecondary, width: '100%' }
            : { ...s.btn, fontSize: 15, padding: '12px 28px', width: '100%' }}
          onClick={onComplete}
        >
          {onConnectEmail ? 'Explore first — I\'ll do it later' : 'Go to my dashboard →'}
        </button>
      </div>
    </div>
  )
}

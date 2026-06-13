import React, { useState } from 'react'
import { colors, s } from '../styles.js'
import type { Workspace } from '../types.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { PLAYBOOKS, type Playbook } from '../lib/playbooks.js'

type Props = {
  workspace: Workspace
  api: ApiHook
  toast: ToastHook
  onComplete: () => void
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

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 28 }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i === current - 1 ? 20 : 8,
            height: 8,
            borderRadius: 99,
            background: i === current - 1 ? colors.blue : colors.border,
            transition: 'all 0.2s'
          }}
        />
      ))}
    </div>
  )
}

export function OnboardingWizard({ workspace, api, toast, onComplete }: Props) {
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
  const [includeExamples, setIncludeExamples] = useState(true)
  const [saving, setSaving] = useState(false)

  function selectPlaybook(pb: Playbook) {
    setSelectedPlaybook(pb)
    setIcpForm(defaultIcpForm(pb))
    setStep(2)
  }

  async function handleSkipSetup() {
    try {
      setSaving(true)
      await api(`/api/workspaces/${workspace.id}/seed`, {
        method: 'POST',
        body: JSON.stringify({ playbookId: null, includeExamples: false })
      })
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
      await api(`/api/workspaces/${workspace.id}/icp`, {
        method: 'PATCH',
        body: JSON.stringify({
          targetIndustries: icpForm.targetIndustries.split('\n').map(s => s.trim()).filter(Boolean),
          targetGeos: icpForm.targetGeos.split('\n').map(s => s.trim()).filter(Boolean),
          minEmployees: null,
          maxEmployees: null,
          mustHaveEmail: false,
          outreachTone: icpForm.outreachTone,
          dailySendLimit: icpForm.dailySendLimit,
          approvalMode: icpForm.approvalMode,
          excludedIndustries: []
        })
      })
      setStep(3)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save ICP settings')
    } finally {
      setSaving(false)
    }
  }

  async function handleStep3Continue(skip: boolean) {
    try {
      setSaving(true)
      const useExamples = skip ? false : includeExamples
      await api(`/api/workspaces/${workspace.id}/seed`, {
        method: 'POST',
        body: JSON.stringify({
          playbookId: selectedPlaybook?.id ?? null,
          includeExamples: useExamples
        })
      })
      setStep(4)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to seed workspace')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <StepDots total={4} current={step} />

        {step === 1 && (
          <Step1
            onSelect={selectPlaybook}
            onSkip={handleSkipSetup}
            saving={saving}
          />
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
            includeExamples={includeExamples}
            onToggleExamples={setIncludeExamples}
            onContinue={() => handleStep3Continue(false)}
            onSkip={() => handleStep3Continue(true)}
            saving={saving}
          />
        )}
        {step === 4 && (
          <Step4
            icpForm={icpForm}
            onComplete={onComplete}
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
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <h1 style={{ color: colors.text, fontSize: 22, fontWeight: 700, margin: '0 0 10px' }}>
          Welcome to ACAOS — let's set up your Acquisition Radar
        </h1>
        <p style={{ color: colors.textMuted, fontSize: 14, margin: 0 }}>
          This takes 3 minutes. We'll configure your intelligence engine and show you live opportunities.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        {PLAYBOOKS.map(pb => (
          <div
            key={pb.id}
            style={{
              background: colors.bgElevated,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 16,
              cursor: 'pointer',
              transition: 'border-color 0.15s'
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = colors.blue)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = colors.border)}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>{pb.icon}</div>
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
            >
              → Select
            </button>
          </div>
        ))}
      </div>

      <div style={{ textAlign: 'center' }}>
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
        Configure your Ideal Customer Profile
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 24px' }}>
        These settings tell ACAOS which signals to surface and who to prioritise.
      </p>

      <div style={{ ...s.stack, gap: 16 }}>
        <div>
          <label style={{ ...s.label }}>Business type</label>
          <input
            style={{ ...s.input }}
            value={form.businessType}
            onChange={e => set('businessType', e.target.value)}
            placeholder="e.g. Industrial Services"
          />
        </div>

        <div>
          <label style={{ ...s.label }}>Target industries (one per line)</label>
          <textarea
            style={{ ...s.textarea, minHeight: 80 }}
            value={form.targetIndustries}
            onChange={e => set('targetIndustries', e.target.value)}
            placeholder="Manufacturing&#10;Construction&#10;Mining"
          />
        </div>

        <div>
          <label style={{ ...s.label }}>Target locations / geos (one per line)</label>
          <textarea
            style={{ ...s.textarea, minHeight: 60 }}
            value={form.targetGeos}
            onChange={e => set('targetGeos', e.target.value)}
            placeholder="Brisbane&#10;Queensland&#10;Australia"
          />
        </div>

        <div style={s.grid2 as React.CSSProperties}>
          <div>
            <label style={{ ...s.label }}>Outreach tone</label>
            <select
              style={{ ...s.input }}
              value={form.outreachTone}
              onChange={e => set('outreachTone', e.target.value)}
            >
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="direct">Direct</option>
            </select>
          </div>
          <div>
            <label style={{ ...s.label }}>Daily send limit</label>
            <input
              type="number"
              style={{ ...s.input }}
              value={form.dailySendLimit}
              min={1}
              max={500}
              onChange={e => set('dailySendLimit', Number(e.target.value))}
            />
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
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
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: colors.blue }}
          />
          <label
            htmlFor="approvalMode"
            style={{ color: colors.text, fontSize: 14, cursor: 'pointer' }}
          >
            Require my approval before sending any outreach
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 28, justifyContent: 'flex-end' }}>
        <button style={{ ...s.btnSecondary }} onClick={onBack} disabled={saving}>
          Back
        </button>
        <button
          style={{ ...s.btn }}
          onClick={onContinue}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}

function Step3({
  playbook,
  includeExamples,
  onToggleExamples,
  onContinue,
  onSkip,
  saving
}: {
  playbook: Playbook
  includeExamples: boolean
  onToggleExamples: (v: boolean) => void
  onContinue: () => void
  onSkip: () => void
  saving: boolean
}) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        ACAOS will show you example opportunities while you add real prospects
      </h2>

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
        We'll seed your radar with 3 clearly marked <strong>EXAMPLE</strong> companies so the dashboard
        never looks empty. These are fictional — you cannot send outreach to them. They disappear once
        you add real prospects.
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ ...s.sectionHeader, marginBottom: 12 }}>Preview — example companies</div>
        <div style={{ ...s.stack, gap: 8 }}>
          {playbook.sampleCompanies.map((c, i) => (
            <div
              key={i}
              style={{
                ...s.cardInner,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <span style={{ color: colors.text, fontSize: 14, fontWeight: 600 }}>
                  {c.companyName}
                </span>
                <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>
                  {c.location} · {c.industry}
                </span>
              </div>
              <span
                style={{
                  background: colors.bgElevated,
                  color: colors.textFaint,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 99,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  letterSpacing: '0.04em'
                }}
              >
                EXAMPLE
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center' }}>
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
          Skip examples
        </button>
        <button
          style={{ ...s.btn }}
          onClick={onContinue}
          disabled={saving}
        >
          {saving ? 'Setting up...' : 'Looks good — let\'s go!'}
        </button>
      </div>
    </div>
  )
}

function Step4({
  icpForm,
  onComplete
}: {
  icpForm: IcpForm
  onComplete: () => void
}) {
  const checks = [
    'ICP configured',
    'Example opportunities loaded',
    'Approval mode on'
  ]

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🎯</div>
      <h2 style={{ color: colors.text, fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>
        Your radar is live.
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 14, margin: '0 0 28px' }}>
        ACAOS is now monitoring signals for your ICP. Let's see your opportunities.
      </p>

      <div
        style={{
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: '16px 20px',
          marginBottom: 28,
          textAlign: 'left'
        }}
      >
        {checks.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 0',
              borderBottom: i < checks.length - 1 ? `1px solid ${colors.border}` : 'none'
            }}
          >
            <span style={{ color: colors.green, fontSize: 16, fontWeight: 700 }}>✓</span>
            <span style={{ color: colors.text, fontSize: 14 }}>{item}</span>
          </div>
        ))}
      </div>

      <button
        style={{ ...s.btn, fontSize: 15, padding: '13px 28px', width: '100%' }}
        onClick={onComplete}
      >
        Open Acquisition Radar →
      </button>
    </div>
  )
}

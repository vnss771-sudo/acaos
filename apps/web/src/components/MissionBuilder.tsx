import React, { useEffect, useState } from 'react'
import type { CreateMissionRequest } from '@acaos/shared'
import { colors, s } from '../styles.js'
import type { Pack, Workspace } from '../types.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  workspace: Workspace
  api: ApiHook
  toast: ToastHook
  onCreated: (campaignId: string, campaignName: string) => void
  onClose: () => void
}

type GoalType = 'BOOK_CALL' | 'GET_REPLY' | 'DRIVE_TRAFFIC' | 'OTHER'

const GOAL_OPTIONS: { value: GoalType; label: string }[] = [
  { value: 'BOOK_CALL', label: 'Book a call' },
  { value: 'GET_REPLY', label: 'Get a reply' },
  { value: 'DRIVE_TRAFFIC', label: 'Drive website traffic' },
  { value: 'OTHER', label: 'Other' }
]

function getCurrentQuarter(): { quarter: number; year: number } {
  const now = new Date()
  const month = now.getMonth() // 0-indexed
  const quarter = Math.floor(month / 3) + 1
  return { quarter, year: now.getFullYear() }
}

function buildDefaultName(answer1: string): string {
  const { quarter, year } = getCurrentQuarter()
  const snippet = answer1.trim().slice(0, 30).trim()
  return `Q${quarter} ${year}${snippet ? ` — ${snippet}` : ''}`
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

export function MissionBuilder({ workspace, api, toast, onCreated, onClose }: Props) {
  const [step, setStep] = useState(1)
  const [answer1, setAnswer1] = useState('')
  const [answer2, setAnswer2] = useState('')
  const [goalType, setGoalType] = useState<GoalType>('BOOK_CALL')
  const [missionName, setMissionName] = useState('')
  const [saving, setSaving] = useState(false)
  const [packs, setPacks] = useState<Pack[]>([])
  const [playbookId, setPlaybookId] = useState('')

  // Playbooks tailor discovery + outreach to a vertical. Optional — a mission
  // without one falls back to the workspace ICP.
  useEffect(() => {
    api<{ packs: Pack[] }>('/api/packs')
      .then(d => setPacks(d.packs || []))
      .catch(() => { /* non-fatal: the picker just stays empty */ })
  }, [api])

  const totalSteps = 4

  function handleNext() {
    if (step === 3) {
      // Pre-fill mission name from answer1 before going to step 4
      if (!missionName) {
        setMissionName(buildDefaultName(answer1))
      }
    }
    setStep(s => s + 1)
  }

  function handleBack() {
    setStep(s => s - 1)
  }

  async function handleLaunch() {
    const name = missionName.trim() || buildDefaultName(answer1)
    setSaving(true)
    try {
      // Creates a first-class Mission and its linked execution Campaign.
      const body: CreateMissionRequest = {
        workspaceId: workspace.id,
        name,
        goalType,
        targetCustomer: answer1.trim(),
        offer: answer2.trim(),
        playbookId: playbookId || null,
      }
      const d = await api<{ mission: { id: string; name: string }; campaign: { id: string; name: string } }>('/api/missions', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      onCreated(d.campaign.id, d.campaign.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create mission')
    } finally {
      setSaving(false)
    }
  }

  const canProceed1 = answer1.trim().length > 0
  const canProceed2 = answer2.trim().length > 0
  const canProceed3 = true // goalType always has a value
  const canLaunch = (missionName.trim() || buildDefaultName(answer1)).length > 0

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        {/* Header row */}
        <div style={{ ...s.flexBetween, marginBottom: 24 }}>
          <div style={{ color: colors.textMuted, fontSize: 13 }}>
            Step {step} of {totalSteps}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: colors.textFaint,
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: 0
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Step progress bar */}
        <div
          style={{
            height: 3,
            background: colors.border,
            borderRadius: 99,
            marginBottom: 28,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${(step / totalSteps) * 100}%`,
              background: colors.blue,
              borderRadius: 99,
              transition: 'width 0.3s ease'
            }}
          />
        </div>

        {step === 1 && (
          <Step1
            value={answer1}
            onChange={setAnswer1}
            onNext={handleNext}
            canNext={canProceed1}
            packs={packs}
            playbookId={playbookId}
            onPlaybook={setPlaybookId}
          />
        )}

        {step === 2 && (
          <Step2
            value={answer2}
            onChange={setAnswer2}
            onBack={handleBack}
            onNext={handleNext}
            canNext={canProceed2}
          />
        )}

        {step === 3 && (
          <Step3
            value={goalType}
            onChange={setGoalType}
            onBack={handleBack}
            onNext={handleNext}
            canNext={canProceed3}
          />
        )}

        {step === 4 && (
          <Step4
            value={missionName || buildDefaultName(answer1)}
            onChange={setMissionName}
            onBack={handleBack}
            onLaunch={handleLaunch}
            canLaunch={canLaunch && !saving}
            saving={saving}
          />
        )}
      </div>
    </div>
  )
}

function Step1({
  value,
  onChange,
  onNext,
  canNext,
  packs,
  playbookId,
  onPlaybook
}: {
  value: string
  onChange: (v: string) => void
  onNext: () => void
  canNext: boolean
  packs: Pack[]
  playbookId: string
  onPlaybook: (v: string) => void
}) {
  const selected = packs.find(p => p.id === playbookId)
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        Who do you want to reach?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
        Describe your target customer — industry, size, location, or any relevant details.
      </p>
      <textarea
        style={{ ...s.textarea, minHeight: 100 }}
        placeholder="e.g. Industrial contractors in Brisbane with 10–50 employees"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
      {packs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <label style={{ display: 'block', color: colors.textFaint, fontSize: 12, marginBottom: 6 }}>
            Playbook (optional) — tailors discovery + outreach to a vertical
          </label>
          <select
            style={{ ...s.input }}
            value={playbookId}
            onChange={e => onPlaybook(e.target.value)}
          >
            <option value="">No playbook — use workspace ICP</option>
            {packs.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {selected && (
            <p style={{ color: colors.textFaint, fontSize: 12, margin: '6px 0 0' }}>{selected.description}</p>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <button
          style={{ ...s.btn, opacity: canNext ? 1 : 0.5, cursor: canNext ? 'pointer' : 'not-allowed' }}
          onClick={onNext}
          disabled={!canNext}
        >
          Next →
        </button>
      </div>
    </div>
  )
}

function Step2({
  value,
  onChange,
  onBack,
  onNext,
  canNext
}: {
  value: string
  onChange: (v: string) => void
  onBack: () => void
  onNext: () => void
  canNext: boolean
}) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        What do you sell or offer?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
        Briefly describe your product or service and the core value it delivers.
      </p>
      <textarea
        style={{ ...s.textarea, minHeight: 100 }}
        placeholder="e.g. Fleet maintenance services for mining and construction equipment"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
        <button style={{ ...s.btnSecondary }} onClick={onBack}>
          Back
        </button>
        <button
          style={{ ...s.btn, opacity: canNext ? 1 : 0.5, cursor: canNext ? 'pointer' : 'not-allowed' }}
          onClick={onNext}
          disabled={!canNext}
        >
          Next →
        </button>
      </div>
    </div>
  )
}

function Step3({
  value,
  onChange,
  onBack,
  onNext,
  canNext
}: {
  value: GoalType
  onChange: (v: GoalType) => void
  onBack: () => void
  onNext: () => void
  canNext: boolean
}) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        What outcome do you want from this mission?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
        This guides how ACAOS frames outreach messages and measures success.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {GOAL_OPTIONS.map(opt => (
          <label
            key={opt.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              background: value === opt.value ? `${colors.blue}22` : colors.bgElevated,
              border: `1px solid ${value === opt.value ? colors.blue : colors.border}`,
              borderRadius: 8,
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <input
              type="radio"
              name="goalType"
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              style={{ accentColor: colors.blue, width: 16, height: 16, cursor: 'pointer' }}
            />
            <span style={{ color: colors.text, fontSize: 14, fontWeight: value === opt.value ? 600 : 400 }}>
              {opt.label}
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
        <button style={{ ...s.btnSecondary }} onClick={onBack}>
          Back
        </button>
        <button
          style={{ ...s.btn, opacity: canNext ? 1 : 0.5, cursor: canNext ? 'pointer' : 'not-allowed' }}
          onClick={onNext}
          disabled={!canNext}
        >
          Next →
        </button>
      </div>
    </div>
  )
}

function Step4({
  value,
  onChange,
  onBack,
  onLaunch,
  canLaunch,
  saving
}: {
  value: string
  onChange: (v: string) => void
  onBack: () => void
  onLaunch: () => void
  canLaunch: boolean
  saving: boolean
}) {
  return (
    <div>
      <h2 style={{ color: colors.text, fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
        What should this mission be called?
      </h2>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
        Give it a name that helps you recognise it later. We've suggested one based on your answers.
      </p>
      <input
        style={{ ...s.input }}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g. Q2 2025 — Industrial contractors in Brisbane..."
        autoFocus
      />
      <p style={{ color: colors.textFaint, fontSize: 12, margin: '8px 0 0' }}>
        You can rename this mission at any time.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
        <button style={{ ...s.btnSecondary }} onClick={onBack} disabled={saving}>
          Back
        </button>
        <button
          style={{
            ...s.btn,
            background: canLaunch ? colors.blue : '#1f2937',
            opacity: canLaunch ? 1 : 0.5,
            cursor: canLaunch ? 'pointer' : 'not-allowed'
          }}
          onClick={onLaunch}
          disabled={!canLaunch}
        >
          {saving ? 'Creating...' : 'Launch Mission'}
        </button>
      </div>
    </div>
  )
}

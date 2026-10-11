import React, { useState } from 'react'
import { s, colors } from '../styles.js'
import { ACTION_NEXT_STEP } from './leads/LeadBrief.js'

// Plain-language rendering of the AI Tools output. The API returns structured
// JSON (it drives scoring and outreach grounding), but a customer should read a
// short briefing or an email, not field names. The raw JSON stays available
// behind a "technical details" toggle for debugging.

const CLASSIFICATION_LABEL: Record<string, string> = {
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  NEEDS_MORE_INFO: 'Wants more information',
  NOT_NOW: 'Not right now',
  OUT_OF_OFFICE: 'Out of office',
  REFERRAL: 'Referred you to someone else',
}

const URGENCY_LABEL: Record<string, string> = {
  immediate: 'Follow up straight away',
  this_week: 'Follow up this week',
  this_month: 'Follow up this month',
  nurture: 'Keep warm for later',
  never: 'No follow-up needed',
}

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])

function parse(raw: string): Json | null {
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : null
  } catch { return null }
}

type Kind = 'research' | 'outreach' | 'reply' | 'unknown'

function kindOf(j: Json | null): Kind {
  if (!j) return 'unknown'
  if (typeof j.subject === 'string' && typeof j.email === 'string') return 'outreach'
  if (typeof j.classification === 'string') return 'reply'
  if ('aiSummary' in j || 'icpScore' in j || 'recommendedAction' in j) return 'research'
  return 'unknown'
}

// The text the Copy button puts on the clipboard: something a person can paste
// into an email or a note, not JSON. Falls back to the raw text when unrecognised.
export function plainTextOf(raw: string): string {
  const j = parse(raw)
  switch (kindOf(j)) {
    case 'outreach':
      return [`Subject: ${str(j!.subject) ?? ''}`, '', str(j!.email) ?? '', ...(str(j!.followup) ? ['', 'Follow-up:', str(j!.followup)!] : [])].join('\n')
    case 'reply':
      return [str(j!.summary), str(j!.suggestedAction) ? `Next step: ${str(j!.suggestedAction)}` : undefined].filter(Boolean).join('\n')
    case 'research':
      return [str(j!.aiSummary), str(j!.outreachAngle) ? `Best way in: ${str(j!.outreachAngle)}` : undefined].filter(Boolean).join('\n')
    default:
      return raw
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  )
}

const body: React.CSSProperties = { color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }
const list: React.CSSProperties = { margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }

function Research({ j }: { j: Json }) {
  const score = typeof j.icpScore === 'number' ? j.icpScore : undefined
  const confidence = str(j.confidence)
  const reasons = Array.isArray(j.evidence)
    ? (j.evidence as Json[]).map((e) => str(e?.signal)).filter((x): x is string => !!x)
    : []
  const signals = strList(j.qualificationSignals)
  const why = signals.length > 0 ? signals : reasons
  const risks = strList(j.riskFlags)
  const action = str(j.recommendedAction)
  const facts: string[] = []
  if (str(j.estimatedTeamSize)) facts.push(`likely ${str(j.estimatedTeamSize)} people`)
  if (str(j.digitalMaturity)) facts.push(`${str(j.digitalMaturity)} digital maturity`)
  if (j.hiringSignals === true) facts.push('actively hiring')

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {score !== undefined && <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>Fit {score}/100</span>}
        {confidence && <span style={s.badge(colors.textFaint)}>{confidence} confidence</span>}
      </div>
      {str(j.aiSummary) && <div style={{ ...body, marginBottom: 6 }}>{str(j.aiSummary)}</div>}
      {facts.length > 0 && (
        <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 14 }}>
          {facts.join(' · ').replace(/^./, (c) => c.toUpperCase())}.
        </div>
      )}
      {why.length > 0 && (
        <Section title={signals.length > 0 ? 'Why they fit' : 'What we found'}>
          <ul style={list}>{why.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Section>
      )}
      {str(j.outreachAngle) && <Section title="Best way in"><div style={body}>{str(j.outreachAngle)}</div></Section>}
      {risks.length > 0 && (
        <Section title="Worth knowing before you reach out">
          <ul style={{ ...list, color: colors.amber }}>{risks.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Section>
      )}
      {action && (
        <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.7 }}>
          <span style={{ color: colors.textFaint }}>Suggested next step — </span>
          {ACTION_NEXT_STEP[action] ?? action}
        </div>
      )}
    </>
  )
}

function Outreach({ j }: { j: Json }) {
  return (
    <>
      <Section title="Subject"><div style={{ ...body, color: colors.text, fontWeight: 600 }}>{str(j.subject)}</div></Section>
      <Section title="Email"><div style={body}>{str(j.email)}</div></Section>
      {str(j.followup) && <Section title="Follow-up if they don't reply (4–5 days later)"><div style={body}>{str(j.followup)}</div></Section>}
    </>
  )
}

function Reply({ j }: { j: Json }) {
  const cls = str(j.classification) ?? ''
  const urgency = str(j.urgency)
  const confidence = typeof j.confidence === 'number' ? j.confidence : undefined
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ color: colors.text, fontSize: 14, fontWeight: 700 }}>{CLASSIFICATION_LABEL[cls] ?? cls}</span>
        {confidence !== undefined && <span style={s.badge(colors.textFaint)}>{confidence}% sure</span>}
        {j.isAutoReply === true && <span style={s.badge(colors.amber)}>Automatic reply</span>}
      </div>
      {str(j.summary) && <div style={{ ...body, marginBottom: 14 }}>{str(j.summary)}</div>}
      {str(j.keyQuote) && <Section title="What they said"><div style={{ ...body, fontStyle: 'italic' }}>“{str(j.keyQuote)}”</div></Section>}
      {str(j.suggestedAction) && <Section title="What to do next"><div style={body}>{str(j.suggestedAction)}</div></Section>}
      {urgency && <div style={{ color: colors.textMuted, fontSize: 13 }}>{URGENCY_LABEL[urgency] ?? urgency}</div>}
    </>
  )
}

export function AiResultCard({ raw, copied, onCopy }: { raw: string; copied: boolean; onCopy: (text: string) => void }) {
  const [showRaw, setShowRaw] = useState(false)
  const j = parse(raw)
  const kind = kindOf(j)
  let pretty = raw
  if (j) pretty = JSON.stringify(j, null, 2)

  return (
    <div style={s.card}>
      <div style={{ ...s.flexBetween, marginBottom: 12 }}>
        <div style={s.sectionHeader}>Result</div>
        <button style={s.btnSm} onClick={() => onCopy(plainTextOf(raw))}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      {kind === 'research' && <Research j={j!} />}
      {kind === 'outreach' && <Outreach j={j!} />}
      {kind === 'reply' && <Reply j={j!} />}
      {kind === 'unknown' && (
        <pre style={{ color: '#e2e8f0', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, lineHeight: 1.6 }}>{pretty}</pre>
      )}

      {kind !== 'unknown' && (
        <div style={{ marginTop: 12 }}>
          <button
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: colors.textFaint, fontSize: 12 }}
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
          >
            {showRaw ? 'Hide technical details' : 'Show technical details'}
          </button>
          {showRaw && (
            <pre style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0', lineHeight: 1.5 }}>{pretty}</pre>
          )}
        </div>
      )}
    </div>
  )
}

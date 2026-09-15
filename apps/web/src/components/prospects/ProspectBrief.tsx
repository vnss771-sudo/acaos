import React from 'react'
import type { Prospect, ScoreBreakdownEntry, FitReason } from '../../types.js'
import { SIGNAL_TYPE_LABELS } from '../../types.js'
import { s, colors } from '../../styles.js'

// Score-dimension display metadata: label, the score it explains, and the
// plain-language sentence that walks a person through why it landed there.
// Kept in one place so the section below stays a simple map/render.
function dimensionColor(v: number): string {
  return v >= 70 ? colors.green : v >= 45 ? colors.amber : colors.textFaint
}

// Picks the signal that contributed the most to the intent score, from the
// real per-signal contributions the API computes (signalIntentContribution),
// not a guess re-derived on the client.
function dominantSignal(breakdown: ScoreBreakdownEntry[]): ScoreBreakdownEntry | undefined {
  if (breakdown.length === 0) return undefined
  return [...breakdown].sort((a, b) => (b.contribution ?? -1) - (a.contribution ?? -1))[0]
}

function intentNarrative(p: Prospect): string {
  const breakdown = p.scoreBreakdown ?? []
  if (breakdown.length === 0) return 'No signals recorded yet, so intent defaults to the baseline.'
  const dominant = dominantSignal(breakdown)
  const distinctTypes = new Set(breakdown.map(b => b.type)).size
  const dominantLabel = dominant ? SIGNAL_TYPE_LABELS[dominant.type] : null
  const corroboration = distinctTypes > 1
    ? `, corroborated by ${distinctTypes - 1} other signal type${distinctTypes - 1 !== 1 ? 's' : ''}`
    : ''
  return dominantLabel
    ? `Driven mainly by their ${dominantLabel.toLowerCase()} signal${dominant?.title ? ` ("${dominant.title}")` : ''}${corroboration}.`
    : 'Based on the signals recorded so far.'
}

function timingNarrative(p: Prospect): string {
  const breakdown = p.scoreBreakdown ?? []
  if (breakdown.length === 0) return 'No signals recorded yet, so timing defaults to the baseline.'
  const mostRecent = [...breakdown].sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())[0]
  const ageDays = Math.max(0, Math.round((Date.now() - new Date(mostRecent.detectedAt).getTime()) / 86_400_000))
  const ageText = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`
  return `Most recent signal — ${SIGNAL_TYPE_LABELS[mostRecent.type]} — was detected ${ageText}.`
}

function confidenceNarrative(p: Prospect): string {
  const signals = p.signals ?? []
  if (signals.length === 0) return 'No signals recorded yet, so confidence defaults to the baseline.'
  const avgReliability = Math.round(signals.reduce((sum, sig) => sum + sig.sourceReliability, 0) / signals.length)
  const avgRelevance = Math.round(signals.reduce((sum, sig) => sum + sig.industryRelevance, 0) / signals.length)
  return `Based on ${signals.length} signal${signals.length !== 1 ? 's' : ''} averaging ${avgReliability}% source reliability and ${avgRelevance}% industry relevance.`
}

function BriefSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  )
}

const briefList: React.CSSProperties = { margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }

// The prospect brief: a plain-language "why this score" narrative — mirroring
// LeadBrief's role for Leads — built entirely from real, already-computed
// evidence (per-signal intent contribution, ICP fit factors, signal recency,
// average source quality, and the buying-stage forecast), not template text.
// Renders nothing until the detail fetch (GET /api/prospects/:id) has
// populated fitBreakdown/prediction, so it never shows stale placeholder text.
export function ProspectBrief({ prospect }: { prospect: Prospect }) {
  const fitReasons: FitReason[] = prospect.fitBreakdown ?? []
  const prediction = prospect.prediction
  if (fitReasons.length === 0 && !prediction) return null

  const dimensions: { label: string; value: number; text: string }[] = [
    { label: 'Intent', value: prospect.intentScore, text: intentNarrative(prospect) },
    { label: 'Fit', value: prospect.fitScore, text: fitReasons.map(r => r.text).join('. ') + (fitReasons.length ? '.' : '') },
    { label: 'Timing', value: prospect.timingScore, text: timingNarrative(prospect) },
    { label: 'Confidence', value: prospect.confidenceScore, text: confidenceNarrative(prospect) },
  ]

  const negativeFit = fitReasons.filter(r => !r.positive)

  return (
    <div style={{ ...s.cardInner, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ color: colors.text, fontSize: 14, fontWeight: 700 }}>Prospect brief</span>
        <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>Opportunity {prospect.opportunityScore}/100</span>
      </div>

      <BriefSection title="Why it's scoring this way">
        <div style={{ display: 'grid', gap: 8 }}>
          {dimensions.map(d => (
            <div key={d.label} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ color: dimensionColor(d.value), fontWeight: 700, fontSize: 13, minWidth: 96 }}>
                {d.label} {d.value}
              </span>
              <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>{d.text}</span>
            </div>
          ))}
        </div>
      </BriefSection>

      {negativeFit.length > 0 && (
        <BriefSection title="Worth knowing before you invest more time">
          <ul style={{ ...briefList, color: colors.amber }}>
            {negativeFit.map((r, i) => <li key={i}>{r.text}</li>)}
          </ul>
        </BriefSection>
      )}

      {prediction && (
        <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.7 }}>
          <span style={{ color: colors.textFaint }}>Suggested next step — </span>
          {prediction.nextAction}
          {prediction.trajectory !== 'STABLE' && (
            <span style={{ color: prediction.trajectory === 'ACCELERATING' ? colors.green : colors.amber }}>
              {' '}({prediction.trajectory === 'ACCELERATING' ? 'trending up' : 'cooling off'})
            </span>
          )}
        </div>
      )}
    </div>
  )
}

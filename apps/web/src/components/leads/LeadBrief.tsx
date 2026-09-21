import React from 'react'
import type { Lead, LeadIntelligence, LeadEvidenceRow } from '../../types.js'
import { s, colors } from '../../styles.js'

const CONFIDENCE_COLOR: Record<string, string> = {
  high: colors.green,
  medium: colors.amber,
  low: colors.textFaint,
}
// Plain-language "what to do next" phrasing for the lead brief, instead of
// surfacing the raw enum (auto_draft / manual_review_then_draft / skip) to the user.
const ACTION_NEXT_STEP: Record<string, string> = {
  auto_draft: 'Ready to draft and reach out — the fit is strong and the evidence holds up.',
  manual_review_then_draft: 'Review, then draft — the signals are promising but unconfirmed, so a person should eyeball it before sending.',
  skip: 'Skip for now — not a strong enough fit to spend outreach on.',
}

// One section of the lead brief: a sentence-case heading over its content. Kept
// deliberately plain (no ALL-CAPS labels, no enum badges) so the whole card reads
// like a short written briefing rather than a dump of structured fields.
function BriefSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  )
}

const briefList: React.CSSProperties = { margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }

// The lead brief: the AI research presented as a clean, plain-language briefing
// — fit, who they are, why they fit, the way in, the caveats, and the next step —
// instead of exposing the raw scoring fields, provenance enums, and action codes.
// It still draws from the same data (the persisted evidence rows preferred over the
// JSON snapshot, the deterministic score rationale, the risk flags), just rendered
// for a person to read. Renders nothing when there's no research yet.
export function LeadBrief({ lead, intel, rows }: { lead: Lead; intel: LeadIntelligence; rows?: LeadEvidenceRow[] }) {
  const evidence = rows && rows.length > 0
    ? rows.map((r) => ({ text: r.signal, sourceUrl: r.sourceUrl }))
    : (intel.evidence ?? []).map((e) => ({ text: e.signal, sourceUrl: e.sourceUrl }))
  // Prefer the deterministic score rationale; fall back to the evidence signals.
  const reasons = (intel.topReasons && intel.topReasons.length > 0)
    ? intel.topReasons.map((t) => ({ text: t, sourceUrl: undefined as string | null | undefined }))
    : evidence
  const riskFlags = intel.riskFlags ?? []
  const score = lead.score > 0 ? lead.score : (intel.finalScore ?? 0)

  // Notable, positive facts only — surface them as a short prose line, not labelled
  // fields. (A "not hiring" or "low maturity" non-signal would just add noise.)
  const facts: string[] = []
  if (intel.estimatedTeamSize) facts.push(`likely ${intel.estimatedTeamSize} people`)
  if (intel.digitalMaturity) facts.push(`${intel.digitalMaturity} digital maturity`)
  if (intel.hiringSignals) facts.push('actively hiring')

  const hasContent = lead.aiSummary || reasons.length > 0 || lead.outreachAngle ||
    riskFlags.length > 0 || intel.recommendedAction || facts.length > 0
  if (!hasContent) return null

  return (
    <div style={{ ...s.cardInner, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ color: colors.text, fontSize: 14, fontWeight: 700 }}>Lead brief</span>
        {score > 0 && <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>ICP fit {score}/100</span>}
        {intel.confidence && <span style={s.badge(CONFIDENCE_COLOR[intel.confidence] ?? colors.textFaint)}>{intel.confidence} confidence</span>}
      </div>

      {(lead.aiSummary || facts.length > 0) && (
        <div style={{ marginBottom: 14 }}>
          {lead.aiSummary && <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{lead.aiSummary}</div>}
          {facts.length > 0 && (
            <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
              {facts.join(' · ').replace(/^./, (c) => c.toUpperCase())}.
            </div>
          )}
        </div>
      )}

      {reasons.length > 0 && (
        <BriefSection title="Why they fit">
          <ul style={briefList}>
            {reasons.map((r, i) => (
              <li key={i}>
                {r.sourceUrl
                  ? <a href={r.sourceUrl} target="_blank" rel="noreferrer" style={{ color: colors.blueLight }}>{r.text}</a>
                  : r.text}
              </li>
            ))}
          </ul>
        </BriefSection>
      )}

      {lead.outreachAngle && (
        <BriefSection title="Best way in">
          <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{lead.outreachAngle}</div>
        </BriefSection>
      )}

      {riskFlags.length > 0 && (
        <BriefSection title="Worth knowing before you reach out">
          <ul style={{ ...briefList, color: colors.amber }}>
            {riskFlags.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </BriefSection>
      )}

      {intel.recommendedAction && (
        <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.7 }}>
          <span style={{ color: colors.textFaint }}>Suggested next step — </span>
          {ACTION_NEXT_STEP[intel.recommendedAction] ?? intel.recommendedAction}
        </div>
      )}
    </div>
  )
}

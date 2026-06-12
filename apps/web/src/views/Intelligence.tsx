import React, { useEffect, useState } from 'react'
import type {
  Workspace, OpportunitiesData, ForecastData, Prospect, View,
  StrategyCardsData, StrategyCard, IndustrySignalConfig,
  OpportunityBrief, SignalEvidenceItem, SignalDecision
} from '../types.js'
import {
  BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, SIGNAL_TYPE_ICONS,
  SIGNAL_TYPE_LABELS, ALL_SIGNAL_TYPES, TIER_COLOR, FPF_COLOR,
  ACTION_COLORS, ACTION_LABELS,
} from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace | null
  toast: ToastHook
  setView: (v: View) => void
}

type ActiveTab = 'opportunities' | 'strategy-cards' | 'forecast' | 'industry-matrix' | 'cadences' | 'briefs' | 'review-queue'

// ── Score Ring ────────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tier = score >= 72 ? 'HOT' : score >= 45 ? 'WARM' : 'COLD'
  const color = TIER_COLOR[tier]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, background: color + '22'
    }}>
      <span style={{ color, fontWeight: 800, fontSize: size * 0.28 }}>{score}</span>
    </div>
  )
}

function ScoreDimension({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? colors.green : value >= 45 ? colors.amber : colors.textFaint
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <div style={{ width: 60, height: 4, background: '#1e2d40', borderRadius: 2, flex: 1 }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ color: colors.textFaint, fontSize: 10, width: 24, textAlign: 'right' }}>{value}</span>
      <span style={{ color: colors.textFaint, fontSize: 10, width: 52 }}>{label}</span>
    </div>
  )
}

// ── Outreach Modal ────────────────────────────────────────────────────────────
function OutreachModal({ subject, body, followup, contactEmail, prospectId, onSend, onClose }: {
  subject: string; body: string; followup: string | null
  contactEmail: string; prospectId: string
  onSend: (prospectId: string, contactEmail: string) => Promise<void>
  onClose: () => void
}) {
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function handleCopy() {
    const text = `Subject: ${subject}\n\n${body}${followup ? `\n\n─── Follow-up ───\n${followup}` : ''}`
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleSend() {
    setSending(true)
    setConfirming(false)
    try { await onSend(prospectId, contactEmail) }
    finally { setSending(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div style={{
        background: colors.bgElevated, border: `1px solid ${colors.border}`,
        borderRadius: 16, padding: 24, maxWidth: 560, width: '100%',
        display: 'flex', flexDirection: 'column', gap: 14
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Generated Outreach</div>
          <button onClick={onClose} style={{ ...s.btnSm, background: 'none', color: colors.textFaint, fontSize: 20, lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div>
          <div style={s.label}>Subject</div>
          <div style={{ ...s.cardInner, color: colors.text, fontSize: 14, fontWeight: 600 }}>{subject}</div>
        </div>

        <div>
          <div style={s.label}>Email Body</div>
          <div style={{
            ...s.cardInner, color: colors.text, fontSize: 13, lineHeight: 1.65,
            whiteSpace: 'pre-wrap', overflowY: 'auto', maxHeight: 260
          }}>{body}</div>
        </div>

        {followup && (
          <div>
            <div style={s.label}>Follow-up</div>
            <div style={{
              ...s.cardInner, color: colors.textMuted, fontSize: 13, lineHeight: 1.65,
              whiteSpace: 'pre-wrap', overflowY: 'auto', maxHeight: 120
            }}>{followup}</div>
          </div>
        )}

        {contactEmail && (
          <div style={{ color: colors.textFaint, fontSize: 12 }}>
            To: <span style={{ color: colors.blueLight }}>{contactEmail}</span>
          </div>
        )}

        {confirming && (
          <div style={{
            background: '#1a2535', border: `1px solid ${colors.amber}`, borderRadius: 8,
            padding: '10px 14px', fontSize: 13, color: colors.amber
          }}>
            Send to <strong>{contactEmail}</strong>? This will deliver the email immediately.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={s.btnGhost} onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          {contactEmail && !confirming && (
            <button style={s.btn} onClick={() => setConfirming(true)}>
              Send Now
            </button>
          )}
          {contactEmail && confirming && (
            <>
              <button style={s.btnGhost} onClick={() => setConfirming(false)}>Cancel</button>
              <button style={{ ...s.btn, background: colors.green }} disabled={sending} onClick={handleSend}>
                {sending ? <><Spinner size={14} color="#fff" /> Sending…</> : 'Confirm Send'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Prospect Card ─────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onOutcome, onOutreach, onEnrollCadence }: {
  prospect: Prospect
  onOutcome: (id: string, stage: string) => void
  onOutreach: (id: string, email: string) => void
  onEnrollCadence: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rec = prospect.topRecommendation
  const sig = prospect.latestSignal
  const signalAge = sig ? Math.round((Date.now() - new Date(sig.detectedAt).getTime()) / 86_400_000) : null

  return (
    <div style={{
      ...s.card, padding: '14px 16px',
      border: `1px solid ${TIER_COLOR[prospect.tier]}33`,
      cursor: 'pointer', transition: 'border-color 0.15s'
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <ScoreRing score={prospect.opportunityScore} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{prospect.companyName}</span>
            <span style={{
              background: BUYING_STAGE_COLOR[prospect.buyingStage] + '33',
              color: BUYING_STAGE_COLOR[prospect.buyingStage],
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99
            }}>{BUYING_STAGE_LABELS[prospect.buyingStage]}</span>
            {prospect.fpf && (
              <span title={prospect.fpf.reason} style={{
                background: FPF_COLOR[prospect.fpf.decision as SignalDecision] + '22',
                color:      FPF_COLOR[prospect.fpf.decision as SignalDecision],
                fontSize: 9, fontWeight: 800, padding: '1px 7px', borderRadius: 99,
                letterSpacing: '0.06em', cursor: 'default'
              }}>{prospect.fpf.decision}</span>
            )}
            {prospect.isActivated && (
              <span style={{
                background: '#78350f33', color: '#fbbf24',
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                letterSpacing: '0.04em'
              }}>⚡ ACTIVATED</span>
            )}
          </div>

          <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 6 }}>
            {[prospect.industry, prospect.location].filter(Boolean).join(' · ')}
          </div>

          {sig && (
            <div style={{
              background: '#0f172a', borderRadius: 6, padding: '6px 10px',
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6
            }}>
              <span style={{ fontSize: 14 }}>{SIGNAL_TYPE_ICONS[sig.type]}</span>
              <span style={{ color: colors.textMuted, fontSize: 12 }}>
                {sig.title || SIGNAL_TYPE_LABELS[sig.type]}
              </span>
              <span style={{ color: colors.textFaint, fontSize: 11, marginLeft: 'auto', flexShrink: 0 }}>
                {signalAge === 0 ? 'today' : `${signalAge}d ago`}
              </span>
            </div>
          )}

          {rec && (
            <div style={{ color: colors.textMuted, fontSize: 12 }}>
              <span style={{
                color: rec.urgency === 'HIGH' ? colors.red : rec.urgency === 'MEDIUM' ? colors.amber : colors.textFaint,
                fontWeight: 700, marginRight: 4
              }}>{rec.urgency}</span>
              {rec.actionText}
            </div>
          )}
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {prospect.winProbability != null && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ color: colors.green, fontWeight: 700, fontSize: 14 }}>
                {Math.round(prospect.winProbability * 100)}%
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>win</div>
            </div>
          )}
          {prospect.expectedRevenueScore > 0 && (
            <div>
              <div style={{ color: colors.amber, fontWeight: 700, fontSize: 12 }}>
                ${prospect.expectedRevenueScore.toLocaleString()}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>exp. rev</div>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}
          onClick={e => e.stopPropagation()}>

          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Score Breakdown</div>
            <ScoreDimension label="Intent" value={prospect.intentScore} />
            <ScoreDimension label="Fit" value={prospect.fitScore} />
            <ScoreDimension label="Timing" value={prospect.timingScore} />
            <ScoreDimension label="Confidence" value={prospect.confidenceScore} />
          </div>

          {prospect.fpf && (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Signal Quality</div>
                <span style={{
                  background: FPF_COLOR[prospect.fpf.decision as SignalDecision] + '22',
                  color:      FPF_COLOR[prospect.fpf.decision as SignalDecision],
                  fontSize: 9, fontWeight: 800, padding: '1px 7px', borderRadius: 99
                }}>{prospect.fpf.decision}</span>
                <span style={{ color: colors.textFaint, fontSize: 10, marginLeft: 'auto' }}>{prospect.fpf.confidence}% confidence</span>
              </div>
              <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>{prospect.fpf.reason}</div>
              {prospect.fpf.riskFlags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                  {prospect.fpf.riskFlags.map(f => (
                    <span key={f} style={{ background: '#1e2d40', color: colors.textFaint, fontSize: 10, padding: '1px 6px', borderRadius: 4 }}>{f}</span>
                  ))}
                </div>
              )}
              {prospect.fpf.rejectionReasons.length > 0 && (
                <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
                  {prospect.fpf.rejectionReasons.slice(0, 3).map((r, i) => <div key={i}>• {r}</div>)}
                  {prospect.fpf.rejectionReasons.length > 3 && <div>+ {prospect.fpf.rejectionReasons.length - 3} more</div>}
                </div>
              )}
            </div>
          )}

          {rec && (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Strategy Card</div>
              {rec.predictedNeed && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: colors.textFaint, fontSize: 10 }}>Predicted Need</div>
                  <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{rec.predictedNeed}</div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {rec.meetingProbability != null && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Meeting Prob</div>
                    <div style={{ color: colors.green, fontSize: 16, fontWeight: 700 }}>
                      {Math.round(rec.meetingProbability * 100)}%
                    </div>
                  </div>
                )}
                {rec.expectedRevenue != null && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Exp. Revenue</div>
                    <div style={{ color: colors.amber, fontSize: 16, fontWeight: 700 }}>
                      ${rec.expectedRevenue.toLocaleString()}
                    </div>
                  </div>
                )}
                {rec.bestContact && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Contact</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestContact}</div>
                  </div>
                )}
                {rec.bestChannel && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Channel</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestChannel}</div>
                  </div>
                )}
              </div>
              {rec.reasoning && (
                <div style={{ color: colors.textMuted, fontSize: 12, fontStyle: 'italic' }}>{rec.reasoning}</div>
              )}
            </div>
          )}

          {(prospect.contactName || prospect.contactEmail) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>Contact</div>
              <div style={{ color: colors.text, fontSize: 13 }}>{prospect.contactName}</div>
              {prospect.contactTitle && <div style={{ color: colors.textFaint, fontSize: 12 }}>{prospect.contactTitle}</div>}
              {prospect.contactEmail && <div style={{ color: colors.blueLight, fontSize: 12 }}>{prospect.contactEmail}</div>}
            </div>
          )}

          {prospect.briefSummary && (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Opportunity Brief</div>
                <span style={{
                  background: prospect.briefSummary.buyingWindowStrength === 'HIGH' ? colors.red + '33'
                    : prospect.briefSummary.buyingWindowStrength === 'MEDIUM' ? colors.amber + '33' : '#47556933',
                  color: prospect.briefSummary.buyingWindowStrength === 'HIGH' ? colors.red
                    : prospect.briefSummary.buyingWindowStrength === 'MEDIUM' ? colors.amber : colors.textFaint,
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99
                }}>{prospect.briefSummary.buyingWindowStrength} WINDOW</span>
                <span style={{ color: colors.textFaint, fontSize: 10, marginLeft: 'auto' }}>
                  {Math.round(prospect.briefSummary.confidenceScore)}% confidence
                </span>
              </div>
              {prospect.briefSummary.likelyProblem && (
                <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: colors.textFaint }}>Problem: </span>{prospect.briefSummary.likelyProblem}
                </div>
              )}
              {prospect.briefSummary.problemOwnerRole && (
                <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: colors.textFaint }}>Owner: </span>{prospect.briefSummary.problemOwnerRole}
                </div>
              )}
              {prospect.briefSummary.offerAngle && (
                <div style={{ color: colors.blueLight, fontSize: 12 }}>
                  <span style={{ color: colors.textFaint }}>Offer: </span>{prospect.briefSummary.offerAngle}
                </div>
              )}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Actions</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {prospect.contactEmail && (
                <button onClick={() => onOutreach(prospect.id, prospect.contactEmail!)}
                  style={{ ...s.btnSm, fontSize: 11, background: '#1e3a5f', color: '#93c5fd' }}>
                  ✉ Generate Outreach
                </button>
              )}
              {prospect.contactEmail && (
                <button onClick={() => onEnrollCadence(prospect.id)}
                  style={{ ...s.btnSm, fontSize: 11, background: '#1a3020', color: '#86efac' }}>
                  ▶ Enroll in Cadence
                </button>
              )}
            </div>
          </div>

          <div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Move to Stage</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const).map(stage => (
                <button key={stage} onClick={() => onOutcome(prospect.id, stage)}
                  style={{
                    ...s.btnSm, fontSize: 11,
                    background: stage === 'WON' ? '#14532d' : stage === 'LOST' ? '#7f1d1d' : '#1e2d40',
                    color: stage === 'WON' ? '#86efac' : stage === 'LOST' ? '#fca5a5' : colors.textMuted
                  }}>
                  {stage}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tier Section ──────────────────────────────────────────────────────────────
function TierSection({ title, prospects, color, onOutcome, onOutreach, onEnrollCadence }: {
  title: string; prospects: Prospect[]; color: string
  onOutcome: (id: string, stage: string) => void
  onOutreach: (id: string, email: string) => void
  onEnrollCadence: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      <button onClick={() => setCollapsed(c => !c)} style={{
        width: '100%', background: 'none', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: 0
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span style={{ color, fontWeight: 700, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</span>
        <span style={{ background: color + '22', color, fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 99 }}>{prospects.length}</span>
        <span style={{ color: colors.textFaint, marginLeft: 'auto', fontSize: 11 }}>{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div style={{ display: 'grid', gap: 8 }}>
          {prospects.length === 0 ? (
            <div style={{ color: colors.textFaint, fontSize: 13, padding: '8px 0' }}>No {title.toLowerCase()} prospects</div>
          ) : (
            prospects.map(p => (
              <ProspectCard
                key={p.id} prospect={p}
                onOutcome={onOutcome} onOutreach={onOutreach} onEnrollCadence={onEnrollCadence}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Strategy Cards Panel ──────────────────────────────────────────────────────
function StrategyCardsPanel({ data, onOutcome }: { data: StrategyCardsData; onOutcome: (id: string, stage: string) => void }) {
  if (data.strategyCards.length === 0) {
    return (
      <div style={s.card}>
        <EmptyState message="No strategy cards yet. Score prospects to generate them." icon="◈" />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {data.strategyCards.map((card, idx) => <StrategyCardRow key={card.id} card={card} rank={idx + 1} onOutcome={onOutcome} />)}
    </div>
  )
}

function StrategyCardRow({ card, rank, onOutcome }: { card: StrategyCard; rank: number; onOutcome: (id: string, stage: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const rec = card.recommendation

  return (
    <div style={{
      ...s.card, padding: '14px 16px',
      border: `1px solid ${TIER_COLOR[card.tier]}33`,
      cursor: 'pointer'
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {/* Rank */}
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#1e2d40', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: colors.textFaint, fontSize: 12, fontWeight: 700, flexShrink: 0
        }}>#{rank}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{card.companyName}</span>
            <span style={{
              background: BUYING_STAGE_COLOR[card.buyingStage] + '33',
              color: BUYING_STAGE_COLOR[card.buyingStage],
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99
            }}>{BUYING_STAGE_LABELS[card.buyingStage]}</span>
            {card.isActivated && (
              <span style={{
                background: '#78350f33', color: '#fbbf24',
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                letterSpacing: '0.04em'
              }}>⚡ ACTIVATED</span>
            )}
          </div>
          {card.industry && (
            <div style={{ color: colors.textFaint, fontSize: 12 }}>
              {[card.industry, card.location].filter(Boolean).join(' · ')}
            </div>
          )}
          {rec?.predictedNeed && (
            <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 3 }}>
              Need: <span style={{ color: colors.text, fontWeight: 500 }}>{rec.predictedNeed}</span>
            </div>
          )}
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ color: colors.amber, fontWeight: 800, fontSize: 18 }}>
              {card.expectedRevenueScore > 0 ? `$${card.expectedRevenueScore.toLocaleString()}` : '–'}
            </div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>exp. revenue</div>
          </div>
          {rec?.meetingProbability != null && (
            <div>
              <div style={{ color: colors.green, fontWeight: 700, fontSize: 16 }}>
                {Math.round(rec.meetingProbability * 100)}%
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>meeting</div>
            </div>
          )}
          <div>
            <div style={{ color: TIER_COLOR[card.tier], fontWeight: 700, fontSize: 14 }}>{card.opportunityScore}</div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>score</div>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}
          onClick={e => e.stopPropagation()}>
          {rec ? (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                {rec.bestChannel && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>CHANNEL</div>
                    <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{rec.bestChannel}</div>
                  </div>
                )}
                {rec.bestTiming && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>TIMING</div>
                    <div style={{ color: colors.text, fontSize: 13 }}>{rec.bestTiming}</div>
                  </div>
                )}
                {rec.messageAngle && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>ANGLE</div>
                    <div style={{ color: colors.text, fontSize: 13 }}>{rec.messageAngle}</div>
                  </div>
                )}
                {card.contactEmail && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>CONTACT</div>
                    <div style={{ color: colors.blueLight, fontSize: 13 }}>{card.contactEmail}</div>
                  </div>
                )}
              </div>
              {rec.actionText && (
                <div style={{ color: colors.blueLight, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{rec.actionText}</div>
              )}
              {rec.reasoning && (
                <div style={{ color: colors.textFaint, fontSize: 12, fontStyle: 'italic' }}>{rec.reasoning}</div>
              )}
            </div>
          ) : (
            <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 12 }}>No strategy card yet — run score-prospects to generate one.</div>
          )}

          <div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Move to Stage</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const).map(stage => (
                <button key={stage} onClick={() => onOutcome(card.id, stage)}
                  style={{
                    ...s.btnSm, fontSize: 11,
                    background: stage === 'WON' ? '#14532d' : stage === 'LOST' ? '#7f1d1d' : '#1e2d40',
                    color: stage === 'WON' ? '#86efac' : stage === 'LOST' ? '#fca5a5' : colors.textMuted
                  }}>
                  {stage}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Forecast Panel ────────────────────────────────────────────────────────────
function ForecastPanel({ forecast }: { forecast: ForecastData }) {
  const s2 = forecast.summary
  return (
    <div style={s.card}>
      <div style={{ ...s.sectionHeader, marginBottom: 14 }}>Revenue Forecast</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Weighted Forecast</div>
          <div style={{ color: colors.green, fontWeight: 800, fontSize: 20 }}>${s2.weightedForecast.toLocaleString()}</div>
        </div>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Pipeline Value</div>
          <div style={{ color: colors.blue, fontWeight: 700, fontSize: 20 }}>${s2.totalPipelineValue.toLocaleString()}</div>
        </div>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Won Revenue</div>
          <div style={{ color: colors.amber, fontWeight: 700, fontSize: 20 }}>${s2.wonRevenue.toLocaleString()}</div>
        </div>
      </div>
      {Object.entries(forecast.stageBreakdown).map(([stage, data]) => (
        <div key={stage} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: colors.textMuted, fontSize: 12 }}>{stage}</span>
            <span style={{ color: colors.text, fontSize: 12 }}>
              {data.count} prospects · ${data.forecast.toLocaleString()}
            </span>
          </div>
          <div style={{ background: '#1e2d40', borderRadius: 3, height: 4 }}>
            <div style={{
              width: `${s2.weightedForecast > 0 ? Math.min(100, (data.forecast / s2.weightedForecast) * 100) : 0}%`,
              height: '100%', background: BUYING_STAGE_COLOR[stage as keyof typeof BUYING_STAGE_COLOR] || colors.blue,
              borderRadius: 3
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Industry Matrix Panel ─────────────────────────────────────────────────────
function IndustryMatrixPanel({ workspaceId, api, toast }: { workspaceId: string; api: ApiHook; toast: ToastHook }) {
  const [configs, setConfigs] = useState<IndustrySignalConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newIndustry, setNewIndustry] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newBoosts, setNewBoosts] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    api<{ configs: IndustrySignalConfig[] }>(`/api/intelligence/industry-configs?workspaceId=${workspaceId}`)
      .then(d => setConfigs(d.configs))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspaceId])

  const handleSave = async () => {
    if (!newIndustry.trim()) return
    setSaving(true)
    try {
      await api(`/api/intelligence/industry-configs/${encodeURIComponent(newIndustry.toLowerCase())}`, {
        method: 'PUT',
        body: JSON.stringify({ workspaceId, signalBoosts: newBoosts, description: newDescription || null })
      })
      toast.success(`Industry config saved for "${newIndustry}"`)
      setShowAdd(false)
      setNewIndustry('')
      setNewDescription('')
      setNewBoosts({})
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (industry: string) => {
    if (!confirm(`Delete config for "${industry}"?`)) return
    try {
      await api(`/api/intelligence/industry-configs/${encodeURIComponent(industry)}`, {
        method: 'DELETE',
        body: JSON.stringify({ workspaceId })
      })
      toast.success(`Deleted config for "${industry}"`)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>

  return (
    <div style={s.stack}>
      <div style={{ ...s.flexBetween }}>
        <div style={{ color: colors.textMuted, fontSize: 13 }}>
          Per-industry signal boost overrides. Higher values (0–100) prioritize that signal type for matching companies.
        </div>
        <button style={s.btn} onClick={() => setShowAdd(true)}>+ Add Industry</button>
      </div>

      {showAdd && (
        <div style={s.card}>
          <div style={{ ...s.sectionHeader, marginBottom: 12 }}>New Industry Config</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div>
              <label style={s.label}>Industry Name</label>
              <input type="text" value={newIndustry}
                onChange={e => setNewIndustry(e.target.value)}
                placeholder="e.g. construction" style={s.input} />
            </div>
            <div>
              <label style={s.label}>Description (optional)</label>
              <input type="text" value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder="e.g. Construction & civil contractors" style={s.input} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 8 }}>Signal Boosts (0–100, leave blank to use default)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {ALL_SIGNAL_TYPES.map(type => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{SIGNAL_TYPE_ICONS[type]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>{SIGNAL_TYPE_LABELS[type]}</div>
                    <input type="number" min={0} max={100}
                      value={newBoosts[type] ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        setNewBoosts(b => v ? { ...b, [type]: Number(v) } : Object.fromEntries(Object.entries(b).filter(([k]) => k !== type)))
                      }}
                      style={{ ...s.input, padding: '3px 6px', fontSize: 11 }}
                      placeholder="–"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving || !newIndustry.trim()} style={s.btn}>
              {saving ? 'Saving…' : 'Save Config'}
            </button>
            <button onClick={() => setShowAdd(false)} style={s.btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {configs.length === 0 && !showAdd ? (
        <div style={s.card}>
          <EmptyState message="No industry configs yet. Add one to customize signal weights per industry." icon="⚙" />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {configs.map(cfg => (
            <div key={cfg.id} style={{ ...s.card, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: colors.text, fontWeight: 700, fontSize: 14, textTransform: 'capitalize' }}>
                    {cfg.industry}
                  </div>
                  {cfg.description && <div style={{ color: colors.textFaint, fontSize: 12 }}>{cfg.description}</div>}
                  <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 2 }}>
                    {Object.keys(cfg.signalBoosts).length} signal overrides
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={s.btnSm} onClick={() => setExpandedId(expandedId === cfg.id ? null : cfg.id)}>
                    {expandedId === cfg.id ? 'Hide' : 'View'}
                  </button>
                  <button style={{ ...s.btnSm, color: colors.red, borderColor: colors.red + '44' }}
                    onClick={() => handleDelete(cfg.industry)}>
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === cfg.id && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {ALL_SIGNAL_TYPES.filter(t => cfg.signalBoosts[t] != null).map(t => (
                      <div key={t} style={{
                        background: '#1e2d40', borderRadius: 6, padding: '4px 10px',
                        display: 'flex', alignItems: 'center', gap: 6
                      }}>
                        <span>{SIGNAL_TYPE_ICONS[t]}</span>
                        <span style={{ color: colors.textFaint, fontSize: 11 }}>{SIGNAL_TYPE_LABELS[t]}</span>
                        <span style={{ color: colors.amber, fontWeight: 700, fontSize: 12 }}>{cfg.signalBoosts[t]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Cadences Panel ────────────────────────────────────────────────────────────
type CadenceEnrollment = {
  id: string
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED'
  currentStep: number
  nextActionAt: string | null
  enrolledAt: string
  completedAt: string | null
  prospect: { id: string; companyName: string; contactEmail: string | null; contactName: string | null }
  cadence: { id: string; name: string; steps: Array<{ dayOffset: number; channel: string; templateType: string }> }
}

function CadencesPanel({ workspaceId, api, toast }: { workspaceId: string; api: ApiHook; toast: ToastHook }) {
  const [enrollments, setEnrollments] = useState<CadenceEnrollment[]>([])
  const [loading, setLoading] = useState(true)
  const [actingOn, setActingOn] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    api<{ enrollments: CadenceEnrollment[] }>(`/api/intelligence/cadences?workspaceId=${workspaceId}`)
      .then(d => setEnrollments(d.enrollments))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspaceId])

  async function handlePause(prospectId: string, enrollmentId: string) {
    setActingOn(enrollmentId)
    try {
      await api(`/api/prospects/${prospectId}/cadence-enrollments/${enrollmentId}/pause`, { method: 'POST', body: '{}' })
      toast.success('Cadence paused')
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setActingOn(null) }
  }

  async function handleResume(prospectId: string, enrollmentId: string) {
    setActingOn(enrollmentId)
    try {
      await api(`/api/prospects/${prospectId}/cadence-enrollments/${enrollmentId}/resume`, { method: 'POST', body: '{}' })
      toast.success('Cadence resumed')
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setActingOn(null) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>

  if (enrollments.length === 0) {
    return (
      <div style={s.card}>
        <EmptyState message="No cadence enrollments yet. Enroll a prospect from the Opportunities tab." icon="◈" />
      </div>
    )
  }

  const byStatus = {
    ACTIVE:    enrollments.filter(e => e.status === 'ACTIVE'),
    PAUSED:    enrollments.filter(e => e.status === 'PAUSED'),
    COMPLETED: enrollments.filter(e => e.status === 'COMPLETED'),
  }

  function StatusSection({ title, items, color }: { title: string; items: CadenceEnrollment[]; color: string }) {
    if (items.length === 0) return null
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
          <span style={{ color, fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{title}</span>
          <span style={{ background: color + '22', color, fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 99 }}>{items.length}</span>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map(e => {
            const stepCount = e.cadence.steps.length
            const nextAt = e.nextActionAt ? new Date(e.nextActionAt) : null
            const overdue = nextAt && nextAt < new Date() && e.status === 'ACTIVE'
            const nextLabel = nextAt
              ? nextAt < new Date()
                ? 'due now'
                : `in ${Math.ceil((nextAt.getTime() - Date.now()) / 86_400_000)}d`
              : '–'
            return (
              <div key={e.id} style={{ ...s.card, padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: colors.text, fontWeight: 600, fontSize: 14 }}>{e.prospect.companyName}</div>
                    {e.prospect.contactEmail && (
                      <div style={{ color: colors.textFaint, fontSize: 12 }}>{e.prospect.contactEmail}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'center', minWidth: 48 }}>
                    <div style={{ color: colors.textMuted, fontSize: 18, fontWeight: 700 }}>
                      {e.currentStep + 1}<span style={{ color: colors.textFaint, fontSize: 12 }}>/{stepCount}</span>
                    </div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>step</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: 60 }}>
                    <div style={{ color: overdue ? colors.amber : colors.textMuted, fontSize: 13, fontWeight: 600 }}>{nextLabel}</div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>next send</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {e.status === 'ACTIVE' && (
                      <button
                        disabled={actingOn === e.id}
                        onClick={() => handlePause(e.prospect.id, e.id)}
                        style={{ ...s.btnSm, fontSize: 11, background: '#78350f33', color: '#fbbf24' }}>
                        {actingOn === e.id ? '…' : '⏸ Pause'}
                      </button>
                    )}
                    {e.status === 'PAUSED' && (
                      <button
                        disabled={actingOn === e.id}
                        onClick={() => handleResume(e.prospect.id, e.id)}
                        style={{ ...s.btnSm, fontSize: 11, background: '#1a3020', color: '#86efac' }}>
                        {actingOn === e.id ? '…' : '▶ Resume'}
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                  {e.cadence.steps.map((step, idx) => (
                    <div key={idx} style={{
                      flex: 1, height: 4, borderRadius: 2,
                      background: idx < e.currentStep
                        ? colors.green
                        : idx === e.currentStep && e.status === 'ACTIVE'
                          ? colors.blue
                          : '#1e2d40'
                    }} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <StatusSection title="Active" items={byStatus.ACTIVE} color={colors.green} />
      <StatusSection title="Paused" items={byStatus.PAUSED} color={colors.amber} />
      <StatusSection title="Completed" items={byStatus.COMPLETED} color={colors.textFaint} />
    </div>
  )
}

// ── Buying Window Timeline ────────────────────────────────────────────────────
function BuyingWindowTimeline({ signals, windowExpiresInDays }: {
  signals: Array<{ type: string; title: string | null; strength: number; detectedAt: string }>
  windowExpiresInDays: number | null
}) {
  const sorted = [...signals].sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime())
  const now = new Date()

  return (
    <div style={{ position: 'relative', paddingLeft: 20 }}>
      {/* Vertical line */}
      <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: colors.border }} />

      {sorted.map((sig, i) => {
        const ageDays = Math.round((now.getTime() - new Date(sig.detectedAt).getTime()) / 86_400_000)
        const icon = SIGNAL_TYPE_ICONS[sig.type as keyof typeof SIGNAL_TYPE_ICONS] ?? '◈'
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10, position: 'relative' }}>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
              background: sig.strength >= 70 ? colors.red : sig.strength >= 45 ? colors.amber : colors.border,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8, marginTop: 1,
            }}>{icon}</div>
            <div>
              <div style={{ color: colors.textMuted, fontSize: 12, fontWeight: 500 }}>
                {SIGNAL_TYPE_LABELS[sig.type as keyof typeof SIGNAL_TYPE_LABELS] ?? sig.type}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 11 }}>
                {sig.title ? `${sig.title} · ` : ''}{ageDays === 0 ? 'today' : `${ageDays}d ago`}
              </div>
            </div>
          </div>
        )
      })}

      {/* Window expiry marker */}
      {windowExpiresInDays !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <div style={{ width: 16, height: 16, borderRadius: '50%', background: windowExpiresInDays <= 7 ? colors.red : colors.amber, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8 }}>⏱</div>
          <div style={{ color: windowExpiresInDays <= 7 ? colors.red : colors.amber, fontSize: 12, fontWeight: 600 }}>
            {windowExpiresInDays <= 0 ? 'Window closing' : `Window closes in ~${windowExpiresInDays} days`}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Brief Card ────────────────────────────────────────────────────────────────
function BriefCard({ brief, prospectId, companyName, workspaceId, api, toast, onRefresh }: {
  brief: OpportunityBrief | null
  prospectId: string
  companyName: string
  workspaceId: string
  api: ApiHook
  toast: ToastHook
  onRefresh: () => void
}) {
  const [generating, setGenerating] = useState(false)
  const [rejectionsOpen, setRejectionsOpen] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await api(`/api/intelligence/briefs/generate`, {
        method: 'POST',
        body: JSON.stringify({ workspaceId, prospectId })
      })
      toast.success('Brief generation queued — refresh in a moment')
      onRefresh()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setGenerating(false) }
  }

  const isExpired = brief ? new Date(brief.expiresAt) < new Date() : false

  if (!brief) {
    return (
      <div style={{ ...s.card, padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ color: colors.text, fontWeight: 600, fontSize: 14 }}>{companyName}</div>
          <button onClick={handleGenerate} disabled={generating}
            style={{ ...s.btnSm, fontSize: 11, background: '#1e3a5f', color: '#93c5fd' }}>
            {generating ? '…' : '+ Generate Brief'}
          </button>
        </div>
        <div style={{ color: colors.textFaint, fontSize: 12 }}>No brief yet for this prospect.</div>
      </div>
    )
  }

  const windowColor = brief.buyingWindowStrength === 'HIGH' ? colors.red
    : brief.buyingWindowStrength === 'MEDIUM' ? colors.amber : colors.textFaint

  return (
    <div style={{ ...s.card, padding: '16px 18px', border: `1px solid ${windowColor}33` }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ color: colors.text, fontWeight: 700, fontSize: 15, flex: 1 }}>{companyName}</div>
        {brief.actionRecommendation && (
          <span style={{
            background: ACTION_COLORS[brief.actionRecommendation] + '22',
            color: ACTION_COLORS[brief.actionRecommendation],
            padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 800,
            letterSpacing: '0.08em', border: `1px solid ${ACTION_COLORS[brief.actionRecommendation]}44`
          }}>
            {ACTION_LABELS[brief.actionRecommendation]}
          </span>
        )}
        <span style={{
          background: windowColor + '22', color: windowColor,
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99
        }}>{brief.buyingWindowStrength} WINDOW</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', border: `2px solid ${colors.blue}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: colors.blue, fontSize: 9, fontWeight: 800 }}>{brief.confidenceScore}</span>
          </div>
          <span style={{ color: colors.textFaint, fontSize: 10 }}>confidence</span>
        </div>
        {isExpired && (
          <button onClick={handleGenerate} disabled={generating}
            style={{ ...s.btnSm, fontSize: 10, background: '#78350f33', color: colors.amber }}>
            {generating ? '…' : '↺ Refresh'}
          </button>
        )}
      </div>

      {/* Why Now */}
      {brief.whyNow.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Why Now</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {brief.whyNow.map((item, i) => {
              const match = item.match(/^\[([A-Z_]+)\](.*)/)
              const icon = match ? SIGNAL_TYPE_ICONS[match[1] as keyof typeof SIGNAL_TYPE_ICONS] ?? '•' : '•'
              const text = match ? match[2].trim() : item
              return (
                <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: colors.textMuted }}>
                  <span style={{ flexShrink: 0 }}>{icon}</span>
                  <span>{text}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Problem / Owner / Offer */}
      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Likely Problem</div>
          <div style={{ color: colors.text, fontSize: 13 }}>{brief.likelyProblem}</div>
        </div>
        <div>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Problem Owner</div>
          <div style={{ color: colors.text, fontSize: 13 }}>{brief.problemOwnerRole}</div>
        </div>
        <div>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Offer Angle</div>
          <div style={{ color: colors.blueLight, fontSize: 13 }}>{brief.offerAngle}</div>
        </div>
      </div>

      {brief.outreachApproach && (
        <div style={{ color: colors.textMuted, fontSize: 12, fontStyle: 'italic', marginBottom: 12 }}>
          {brief.outreachApproach}
        </div>
      )}

      {brief.whatNotToSay && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#1a0a0a', border: `1px solid ${colors.red}33`, borderRadius: 6 }}>
          <span style={{ color: colors.red, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>What not to say: </span>
          <span style={{ color: colors.textMuted, fontSize: 13 }}>{brief.whatNotToSay}</span>
        </div>
      )}

      {/* Score dimensions mini-bar */}
      {brief.scoreBenchmark && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Score Evidence</div>
          <ScoreDimension label="Intent"      value={brief.scoreBenchmark.intentScore     ?? 0} />
          <ScoreDimension label="Fit"         value={brief.scoreBenchmark.fitScore        ?? 0} />
          <ScoreDimension label="Timing"      value={brief.scoreBenchmark.timingScore     ?? 0} />
          <ScoreDimension label="Confidence"  value={brief.scoreBenchmark.confidenceScore ?? 0} />
        </div>
      )}

      {/* Evidence chips */}
      {brief.evidenceItems && brief.evidenceItems.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {(brief.evidenceItems as SignalEvidenceItem[]).map((item, i) => (
            <div key={i} style={{
              background: item.isLeading ? '#1e3a5f' : '#1e2d40',
              border: `1px solid ${item.isLeading ? '#3b82f633' : colors.border}`,
              borderRadius: 6, padding: '3px 8px',
              display: 'flex', alignItems: 'center', gap: 4
            }}>
              <span style={{ fontSize: 11 }}>{SIGNAL_TYPE_ICONS[item.type as keyof typeof SIGNAL_TYPE_ICONS] ?? '•'}</span>
              <span style={{ color: colors.textMuted, fontSize: 11 }}>{item.label}</span>
              <span style={{ color: colors.blueLight, fontSize: 11, fontWeight: 700 }}>+{item.contribution}</span>
            </div>
          ))}
        </div>
      )}

      {/* Buying Window Timeline */}
      {brief.evidenceItems && brief.evidenceItems.length > 0 && (
        <div style={{ marginTop: 16, marginBottom: 12 }}>
          <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Signal Timeline</div>
          <BuyingWindowTimeline
            signals={brief.evidenceItems.map(e => ({
              type: e.type, title: e.label, strength: e.rawStrength,
              detectedAt: new Date(Date.now() - e.ageDays * 86_400_000).toISOString()
            }))}
            windowExpiresInDays={brief.windowExpiresInDays ?? null}
          />
        </div>
      )}

      {/* Rejected signals collapsible */}
      {brief.rejectionReasons && brief.rejectionReasons.length > 0 && (
        <div>
          <button onClick={() => setRejectionsOpen(r => !r)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.textFaint, fontSize: 10, padding: 0, display: 'flex', alignItems: 'center', gap: 4
          }}>
            {rejectionsOpen ? '▼' : '▶'} {brief.rejectionReasons.length} weak/rejected signals
          </button>
          {rejectionsOpen && (
            <div style={{ marginTop: 6, paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {brief.rejectionReasons.map((r, i) => (
                <div key={i} style={{ color: colors.textFaint, fontSize: 11 }}>• {r}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Briefs Panel ──────────────────────────────────────────────────────────────
function BriefsPanel({ workspace, api, toast, setView }: { workspace: Workspace; api: ApiHook; toast: ToastHook; setView: (v: View) => void }) {
  const [briefs, setBriefs] = useState<OpportunityBrief[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [hasProduct, setHasProduct] = useState<boolean | null>(null)

  const load = () => {
    setLoading(true)
    Promise.all([
      api<{ briefs: OpportunityBrief[] }>(`/api/intelligence/briefs?workspaceId=${workspace.id}`),
      api<{ workspaceProduct: { productName?: string } | null }>(`/api/workspaces/${workspace.id}/product`).catch(() => ({ workspaceProduct: null })),
    ])
      .then(([d, p]) => {
        setBriefs(d.briefs)
        setHasProduct(Boolean(p.workspaceProduct?.productName?.trim()))
      })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspace.id])

  const handleGenerateAll = async () => {
    setGenerating(true)
    try {
      const result = await api<{ queued: number }>('/api/intelligence/briefs/generate', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id })
      })
      toast.success(`Queued ${result.queued} briefs — refresh in a moment`)
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setGenerating(false) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>

  return (
    <div style={s.stack}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: colors.textMuted, fontSize: 13 }}>
          {briefs.length} opportunity brief{briefs.length !== 1 ? 's' : ''} — evidence-backed signal→problem→owner→offer dossiers
        </div>
        <button onClick={handleGenerateAll} disabled={generating} style={{ ...s.btn, fontSize: 12 }}>
          {generating ? '⏳ Queuing…' : '⚡ Generate All HOT+WARM'}
        </button>
      </div>

      {hasProduct === false && (
        <div style={{
          background: '#1e293b', border: '1px solid #f59e0b44', borderRadius: 8,
          padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: '#f59e0b', fontSize: 13 }}>
            Your briefs will be generic until you add your product context — what you sell, who you sell to, and your key pain points.
          </span>
          <button onClick={() => setView('settings')} style={{ ...s.btn, fontSize: 12, flexShrink: 0 }}>
            Add product context
          </button>
        </div>
      )}

      {briefs.length === 0 ? (
        <div style={s.card}>
          <EmptyState
            message="No briefs yet. Run Intelligence to score prospects and auto-generate briefs for HOT prospects (score ≥ 72), or click Generate All HOT+WARM."
            icon="◈"
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {briefs
            .sort((a, b) => {
              const w = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const
              return (w[b.buyingWindowStrength] ?? 0) - (w[a.buyingWindowStrength] ?? 0)
            })
            .map(brief => (
              <BriefCard
                key={brief.id}
                brief={brief}
                prospectId={brief.prospectId}
                companyName={brief.prospect?.companyName ?? brief.prospectId}
                workspaceId={workspace.id}
                api={api}
                toast={toast}
                onRefresh={load}
              />
            ))}
        </div>
      )}
    </div>
  )
}

// ── Review Queue Panel ────────────────────────────────────────────────────────
type PendingEnrollment = {
  id: string
  status: string
  prospect: { id: string; companyName: string; contactEmail: string | null; industry: string | null; opportunityScore: number; buyingStage: string }
  cadence: { id: string; name: string }
}

function ReviewQueuePanel({ api, workspace, toast }: { api: ApiHook; workspace: Workspace; toast: ToastHook }) {
  const [enrollments, setEnrollments] = useState<PendingEnrollment[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api<{ enrollments: PendingEnrollment[]; count: number }>(`/api/workspaces/${workspace.id}/pending-reviews`)
      .then(d => setEnrollments(d.enrollments))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workspace.id])

  async function handleApprove(enrollment: PendingEnrollment) {
    setActing(a => ({ ...a, [enrollment.id]: true }))
    try {
      await api(`/api/prospects/${enrollment.prospect.id}/cadence-enrollments/${enrollment.id}/approve`, { method: 'POST' })
      setEnrollments(prev => prev.filter(e => e.id !== enrollment.id))
      toast.success(`Approved — outreach queued for ${enrollment.prospect.companyName}`)
    } catch (e) { toast.error((e as Error).message) }
    finally { setActing(a => ({ ...a, [enrollment.id]: false })) }
  }

  async function handleDiscard(enrollment: PendingEnrollment) {
    setActing(a => ({ ...a, [enrollment.id]: true }))
    try {
      await api(`/api/prospects/${enrollment.prospect.id}/cadence-enrollments/${enrollment.id}/pause`, { method: 'POST' })
      setEnrollments(prev => prev.filter(e => e.id !== enrollment.id))
      toast.success(`Discarded — enrollment paused`)
    } catch (e) { toast.error((e as Error).message) }
    finally { setActing(a => ({ ...a, [enrollment.id]: false })) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>

  if (enrollments.length === 0) {
    return (
      <div style={s.card}>
        <EmptyState message="All caught up — no outreach pending review" icon="✓" />
      </div>
    )
  }

  return (
    <div style={s.stack}>
      <div style={{ color: colors.textFaint, fontSize: 13 }}>
        {enrollments.length} outreach email{enrollments.length !== 1 ? 's' : ''} awaiting your approval
      </div>
      {enrollments.map(e => (
        <div key={e.id} style={{ ...s.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <ScoreRing score={e.prospect.opportunityScore} size={44} />
            <div>
              <div style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{e.prospect.companyName}</div>
              <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 2 }}>
                {e.prospect.industry ?? '—'} · {e.prospect.contactEmail ?? 'No email'} · {e.cadence.name}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...s.btnSm, background: '#16a34a', color: '#fff', fontWeight: 600 }}
              disabled={acting[e.id]}
              onClick={() => handleApprove(e)}
            >
              {acting[e.id] ? <Spinner size={12} color="#fff" /> : 'Approve'}
            </button>
            <button
              style={s.btnDanger}
              disabled={acting[e.id]}
              onClick={() => handleDiscard(e)}
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main Intelligence View ────────────────────────────────────────────────────
export function Intelligence({ api, workspace, toast, setView }: Props) {
  const [opportunities, setOpportunities] = useState<OpportunitiesData | null>(null)
  const [strategyCards, setStrategyCards] = useState<StrategyCardsData | null>(null)
  const [forecast, setForecast] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>('opportunities')
  const [outreachModal, setOutreachModal] = useState<{
    subject: string; body: string; followup: string | null
    prospectId: string; contactEmail: string
  } | null>(null)

  const load = () => {
    if (!workspace) return
    setLoading(true)
    Promise.all([
      api<OpportunitiesData>(`/api/intelligence/opportunities?workspaceId=${workspace.id}`),
      api<StrategyCardsData>(`/api/intelligence/strategy-cards?workspaceId=${workspace.id}&limit=20`),
      api<ForecastData>(`/api/intelligence/forecast?workspaceId=${workspace.id}`)
    ])
      .then(([opp, sc, fc]) => { setOpportunities(opp); setStrategyCards(sc); setForecast(fc) })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspace?.id])

  const handleOutcome = async (prospectId: string, stage: string) => {
    if (!workspace) return
    try {
      await api(`/api/prospects/${prospectId}/outcome`, {
        method: 'POST',
        body: JSON.stringify({ stage })
      })
      toast.success(`Moved to ${stage}`)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleOutreach = async (prospectId: string, contactEmail: string) => {
    if (!workspace) return
    try {
      const result = await api<{ subject: string; email: string; followup: string | null }>(`/api/prospects/${prospectId}/outreach`, {
        method: 'POST',
        body: JSON.stringify({ send: false })
      })
      setOutreachModal({ subject: result.subject, body: result.email, followup: result.followup, prospectId, contactEmail })
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleSendOutreach = async (prospectId: string, contactEmail: string) => {
    if (!outreachModal) return
    try {
      // Pass the exact reviewed copy so the API sends what the user approved,
      // not a freshly generated version that may differ.
      await api(`/api/prospects/${prospectId}/outreach`, {
        method: 'POST',
        body: JSON.stringify({
          send:        true,
          confirmSend: true,
          contactEmail,
          subject:     outreachModal.subject,
          emailBody:   outreachModal.body,
        })
      })
      setOutreachModal(null)
      toast.success('Email sent')
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleEnrollCadence = async (prospectId: string) => {
    if (!workspace) return
    try {
      await api(`/api/prospects/${prospectId}/enroll-cadence`, {
        method: 'POST',
        body: JSON.stringify({})
      })
      toast.success('Enrolled in 3-step email cadence')
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const [pendingReviewCount, setPendingReviewCount] = useState(0)
  useEffect(() => {
    if (!workspace) return
    api<{ count: number }>(`/api/workspaces/${workspace.id}/pending-reviews`)
      .then(d => setPendingReviewCount(d.count))
      .catch(() => {})
  }, [workspace?.id])

  const [running, setRunning] = useState(false)
  const handleRunIntelligence = async () => {
    if (!workspace || running) return
    setRunning(true)
    try {
      await api('/api/intelligence/run', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id })
      })
      toast.success('Intelligence cycle queued — scores will refresh shortly')
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setRunning(false) }
  }

  if (!workspace) {
    return <div style={s.card}><EmptyState message="No workspace selected" icon="◈" /></div>
  }

  const totals = opportunities?.totals

  const TABS: { key: ActiveTab; label: string }[] = [
    { key: 'opportunities', label: 'Opportunities' },
    { key: 'briefs', label: 'Briefs' },
    { key: 'strategy-cards', label: 'Strategy Cards' },
    { key: 'forecast', label: 'Revenue Forecast' },
    { key: 'industry-matrix', label: 'Industry Matrix' },
    { key: 'cadences', label: 'Cadences' },
    { key: 'review-queue', label: pendingReviewCount > 0 ? `Review Queue (${pendingReviewCount})` : 'Review Queue' },
  ]

  return (
    <div style={s.stack}>
      {/* Header row with Run Intelligence button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div />
        <button onClick={handleRunIntelligence} disabled={running}
          style={{ ...s.btnSm, background: '#1e3a5f', color: running ? colors.textFaint : '#93c5fd', fontSize: 12, padding: '6px 14px' }}>
          {running ? '⏳ Running…' : '⚡ Run Intelligence'}
        </button>
      </div>

      {/* KPI Bar */}
      <div style={s.grid4}>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Total Prospects</div>
          <div style={{ color: colors.blueLight, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.total ?? 0)}</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>ACT</div>
          <div style={{ color: ACTION_COLORS.ACT, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.hot ?? 0)}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>Score ≥ 72</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>WATCH</div>
          <div style={{ color: ACTION_COLORS.WATCH, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.warm ?? 0)}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>Score 45–71</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Strategy Cards</div>
          <div style={{ color: colors.amber, fontSize: 28, fontWeight: 800 }}>
            {loading ? '…' : (strategyCards?.strategyCards.length ?? 0)}
          </div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>by expected revenue</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: colors.bgSurface, borderRadius: 8, padding: 4, border: `1px solid ${colors.border}`, width: 'fit-content', flexWrap: 'wrap' }}>
        {TABS.map(({ key, label }) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            ...s.btnSm,
            background: activeTab === key ? (key === 'strategy-cards' ? colors.amber : colors.blue) : 'transparent',
            color: activeTab === key ? (key === 'strategy-cards' ? '#000' : '#fff') : colors.textMuted,
            fontWeight: activeTab === key ? 600 : 400, padding: '6px 16px', fontSize: 13
          }}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
      ) : activeTab === 'opportunities' ? (
        opportunities ? (
          <div style={{ display: 'grid', gap: 24 }}>
            <TierSection title="ACT" prospects={opportunities.hot} color={ACTION_COLORS.ACT} onOutcome={handleOutcome} onOutreach={handleOutreach} onEnrollCadence={handleEnrollCadence} />
            <TierSection title="WATCH" prospects={opportunities.warm} color={ACTION_COLORS.WATCH} onOutcome={handleOutcome} onOutreach={handleOutreach} onEnrollCadence={handleEnrollCadence} />
            <TierSection title="IGNORE" prospects={opportunities.cold} color={ACTION_COLORS.IGNORE} onOutcome={handleOutcome} onOutreach={handleOutreach} onEnrollCadence={handleEnrollCadence} />
          </div>
        ) : (
          <div style={s.card}>
            <EmptyState message="No prospects yet. Add your first prospect to get started." icon="◈" />
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button style={s.btn} onClick={() => setView('prospects')}>Add Prospect</button>
            </div>
          </div>
        )
      ) : activeTab === 'briefs' ? (
        <BriefsPanel workspace={workspace} api={api} toast={toast} setView={setView} />
      ) : activeTab === 'strategy-cards' ? (
        strategyCards ? (
          <StrategyCardsPanel data={strategyCards} onOutcome={handleOutcome} />
        ) : (
          <div style={s.card}><EmptyState message="No strategy cards yet." icon="◈" /></div>
        )
      ) : activeTab === 'forecast' ? (
        forecast ? <ForecastPanel forecast={forecast} /> : null
      ) : activeTab === 'cadences' ? (
        <CadencesPanel workspaceId={workspace.id} api={api} toast={toast} />
      ) : activeTab === 'review-queue' ? (
        <ReviewQueuePanel api={api} workspace={workspace} toast={toast} />
      ) : (
        <IndustryMatrixPanel workspaceId={workspace.id} api={api} toast={toast} />
      )}

      {outreachModal && (
        <OutreachModal
          subject={outreachModal.subject}
          body={outreachModal.body}
          followup={outreachModal.followup}
          contactEmail={outreachModal.contactEmail}
          prospectId={outreachModal.prospectId}
          onSend={handleSendOutreach}
          onClose={() => setOutreachModal(null)}
        />
      )}
    </div>
  )
}

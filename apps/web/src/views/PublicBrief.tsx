import React, { useEffect, useState, useRef } from 'react'
import type { SignalType } from '../types.js'
import { SIGNAL_TYPE_ICONS, SIGNAL_TYPE_LABELS, ACTION_COLORS, ACTION_LABELS } from '../types.js'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

type BriefData = {
  companyName: string
  industry: string | null
  location: string | null
  employeeCount: number | null
  contactName: string | null
  contactTitle: string | null
  signals: Array<{
    type: SignalType
    title: string | null
    description: string | null
    strength: number
    detectedAt: string
  }>
  brief: {
    buyingWindowStrength: 'HIGH' | 'MEDIUM' | 'LOW'
    whyNow: string[]
    likelyProblem: string
    problemOwnerRole: string
    offerAngle: string
    outreachApproach: string
    confidenceScore: number
    actionRecommendation?: 'ACT' | 'WATCH' | 'IGNORE' | null
    whatNotToSay?: string | null
    windowExpiresInDays?: number | null
  } | null
  product: {
    productName: string
    keyPainPoints: string[]
    differentiators: string[]
    ctaType: string
    calendarUrl: string | null
  } | null
  outcomeStage: string
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

const clr = {
  bg:        '#030712',
  surface:   '#0d1626',
  card:      '#111827',
  border:    '#1e2d40',
  text:      '#e2e8f0',
  muted:     '#94a3b8',
  faint:     '#475569',
  blue:      '#3b82f6',
  green:     '#22c55e',
  amber:     '#f59e0b',
  red:       '#ef4444',
  purple:    '#8b5cf6',
}

function ageDaysLabel(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.round(days / 7)}w ago`
  return `${Math.round(days / 30)}mo ago`
}

function StrengthBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value))
  const col = pct >= 70 ? clr.red : pct >= 45 ? clr.amber : clr.faint
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: '#1e2d40', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, color: clr.faint, width: 24, textAlign: 'right' }}>{pct}</span>
    </div>
  )
}

function WindowBadge({ strength }: { strength: 'HIGH' | 'MEDIUM' | 'LOW' }) {
  const cfg = {
    HIGH:   { label: 'HIGH BUYING SIGNAL', color: clr.red,   bg: '#7f1d1d33' },
    MEDIUM: { label: 'MEDIUM SIGNAL',      color: clr.amber, bg: '#78350f33' },
    LOW:    { label: 'LOW SIGNAL',          color: clr.faint, bg: '#1f293733' },
  }[strength]
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
      color: cfg.color, background: cfg.bg,
      padding: '3px 8px', borderRadius: 4, border: `1px solid ${cfg.color}44`
    }}>
      {cfg.label}
    </span>
  )
}

export function PublicBrief({ token }: { token: string }) {
  const [data, setData]     = useState<BriefData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [ctaDone, setCtaDone] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${API}/api/pub/${token}`)
      .then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => { throw new Error(e.error ?? 'Not found') }))
      .then((d: BriefData) => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [token])

  useEffect(() => {
    if (chatOpen && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatHistory, chatOpen])

  async function sendCta(ctaType: string) {
    if (ctaDone) return
    await fetch(`${API}/api/pub/${token}/cta`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ctaType }),
    }).catch(() => {})
    setCtaDone(true)
  }

  async function sendChatMessage() {
    const msg = chatInput.trim()
    if (!msg || chatLoading) return
    const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: msg }]
    setChatHistory(newHistory)
    setChatInput('')
    setChatLoading(true)
    try {
      const res = await fetch(`${API}/api/pub/${token}/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: msg, history: chatHistory }),
      })
      const json = await res.json() as { reply?: string; error?: string }
      setChatHistory([...newHistory, { role: 'assistant', content: json.reply ?? 'Sorry, something went wrong.' }])
    } catch {
      setChatHistory([...newHistory, { role: 'assistant', content: 'Connection error — please try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  const base: React.CSSProperties = {
    minHeight: '100vh', background: clr.bg, color: clr.text,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 15, lineHeight: 1.6,
  }

  if (loading) return (
    <div style={{ ...base, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: clr.faint }}>Loading…</span>
    </div>
  )

  if (error || !data) return (
    <div style={{ ...base, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32 }}>
      <div>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⚡</div>
        <div style={{ color: clr.text, fontWeight: 600, marginBottom: 8 }}>Page not found</div>
        <div style={{ color: clr.faint, fontSize: 14 }}>{error ?? 'This link may have expired or is invalid.'}</div>
      </div>
    </div>
  )

  const { brief, product, signals } = data
  const calUrl = product?.calendarUrl
  const ctaType = product?.ctaType ?? 'book_call'

  return (
    <div style={base}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={{
        background: clr.surface, borderBottom: `1px solid ${clr.border}`,
        padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: clr.blue }}>⚡</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: clr.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Intelligence Brief
          </span>
        </div>
        <span style={{ fontSize: 12, color: clr.faint }}>Powered by ACAOS</span>
      </header>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '32px 20px 120px' }}>

        {/* ── Company hero ─────────────────────────────────────────────── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <h1 style={{ margin: '0 0 6px', fontSize: 28, fontWeight: 800, color: clr.text }}>
                {data.companyName}
              </h1>
              <div style={{ color: clr.muted, fontSize: 14 }}>
                {[data.industry, data.location, data.employeeCount ? `${data.employeeCount} employees` : null]
                  .filter(Boolean).join(' · ')}
              </div>
              {data.contactName && (
                <div style={{ color: clr.faint, fontSize: 13, marginTop: 4 }}>
                  For: {data.contactName}{data.contactTitle ? ` — ${data.contactTitle}` : ''}
                </div>
              )}
            </div>
            {brief && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
                <WindowBadge strength={brief.buyingWindowStrength} />
                {brief.actionRecommendation && (
                  <span style={{
                    background: `${ACTION_COLORS[brief.actionRecommendation]}26`,
                    color: ACTION_COLORS[brief.actionRecommendation],
                    padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 800,
                    letterSpacing: '0.06em'
                  }}>
                    {ACTION_LABELS[brief.actionRecommendation]}
                  </span>
                )}
                <span style={{
                  fontSize: 11, color: clr.faint,
                  background: '#1e2d40', padding: '3px 8px', borderRadius: 4,
                }}>
                  {brief.confidenceScore}% confidence
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Why Now ──────────────────────────────────────────────────── */}
        {brief && brief.whyNow.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: clr.amber, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 14px' }}>
              Why Now
            </h2>
            <div style={{ background: clr.surface, border: `1px solid ${clr.border}`, borderRadius: 12, padding: 20 }}>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {brief.whyNow.map((bullet, i) => (
                  <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ color: clr.amber, flexShrink: 0, marginTop: 2 }}>◆</span>
                    <span style={{ color: clr.text, fontSize: 14 }}>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* ── Problem · Owner · Offer ───────────────────────────────────── */}
        {brief && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: clr.blue, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 14px' }}>
              Intelligence Analysis
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {[
                { label: 'Likely Problem',  icon: '🔍', value: brief.likelyProblem,    color: clr.red },
                { label: 'Problem Owner',   icon: '👤', value: brief.problemOwnerRole, color: clr.purple },
                { label: 'Offer Angle',     icon: '🎯', value: brief.offerAngle,        color: clr.green },
              ].map(({ label, icon, value, color }) => (
                <div key={label} style={{
                  background: clr.card, border: `1px solid ${clr.border}`,
                  borderRadius: 10, padding: 16,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: clr.faint, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                    {icon} {label}
                  </div>
                  <div style={{ fontSize: 14, color: clr.text, lineHeight: 1.5 }}>{value}</div>
                </div>
              ))}
            </div>
            {brief.outreachApproach && (
              <div style={{ marginTop: 10, padding: '10px 14px', background: '#1e2d40', borderRadius: 8, fontSize: 13, color: clr.muted, fontStyle: 'italic' }}>
                💬 {brief.outreachApproach}
              </div>
            )}
            {brief.whatNotToSay && (
              <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8 }}>
                <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Avoid: </span>
                <span style={{ color: '#94a3b8', fontSize: 13 }}>{brief.whatNotToSay}</span>
              </div>
            )}
          </section>
        )}

        {/* ── Signal Timeline ───────────────────────────────────────────── */}
        {signals.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: clr.muted, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 14px' }}>
              Market Signals Detected
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {signals.map((sig, i) => {
                const icon  = SIGNAL_TYPE_ICONS[sig.type] ?? '📡'
                const label = SIGNAL_TYPE_LABELS[sig.type] ?? sig.type
                return (
                  <div key={i} style={{
                    background: clr.surface, border: `1px solid ${clr.border}`,
                    borderRadius: 10, padding: '12px 16px',
                    display: 'grid', gridTemplateColumns: '32px 1fr 80px', gap: 10, alignItems: 'start',
                  }}>
                    <span style={{ fontSize: 20 }}>{icon}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: clr.text }}>
                        {sig.title ?? label}
                      </div>
                      {sig.description && (
                        <div style={{ fontSize: 12, color: clr.faint, marginTop: 2 }}>{sig.description}</div>
                      )}
                      <div style={{ fontSize: 11, color: clr.faint, marginTop: 4 }}>{label} · {ageDaysLabel(sig.detectedAt)}</div>
                    </div>
                    <div style={{ paddingTop: 4 }}>
                      <StrengthBar value={sig.strength} />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── CTAs ─────────────────────────────────────────────────────── */}
        <section style={{ marginBottom: 28 }}>
          <div style={{
            background: clr.surface, border: `1px solid ${clr.border}`,
            borderRadius: 12, padding: 24, textAlign: 'center',
          }}>
            {!ctaDone ? (
              <>
                <div style={{ fontSize: 15, color: clr.muted, marginBottom: 16 }}>
                  {product ? `Ready to see how ${product.productName} addresses these challenges?` : 'Ready to learn more?'}
                </div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {(ctaType === 'book_call' || ctaType === 'demo') && calUrl && (
                    <a
                      href={calUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => sendCta('book_call')}
                      style={{
                        display: 'inline-block', padding: '12px 28px',
                        background: clr.blue, color: '#fff', borderRadius: 8,
                        fontWeight: 700, fontSize: 15, textDecoration: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      📅 Book a Call
                    </a>
                  )}
                  <button
                    onClick={() => sendCta('free_trial')}
                    style={{
                      padding: '12px 28px', background: 'transparent',
                      border: `1px solid ${clr.green}`, color: clr.green,
                      borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: 'pointer',
                    }}
                  >
                    🚀 Start Free Trial
                  </button>
                </div>
              </>
            ) : (
              <div style={{ color: clr.green, fontWeight: 600 }}>
                ✓ Thanks — someone from the team will be in touch shortly.
              </div>
            )}
          </div>
        </section>

      </div>

      {/* ── AI Guide Chat Widget ──────────────────────────────────────── */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 100 }}>
        {chatOpen ? (
          <div style={{
            width: 340, height: 460,
            background: clr.card, border: `1px solid ${clr.border}`,
            borderRadius: 16, boxShadow: '0 20px 60px #00000060',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Chat header */}
            <div style={{
              padding: '12px 16px', background: clr.surface,
              borderBottom: `1px solid ${clr.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>⚡</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: clr.text }}>AI Guide</span>
                <span style={{ fontSize: 11, color: clr.green }}>● Live</span>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                style={{ background: 'none', border: 'none', color: clr.faint, cursor: 'pointer', fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatHistory.length === 0 && (
                <div style={{ color: clr.faint, fontSize: 13, textAlign: 'center', marginTop: 16 }}>
                  Ask me anything about how we can help {data.companyName}.
                </div>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} style={{
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                }}>
                  <div style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: msg.role === 'user' ? clr.blue : clr.surface,
                    color: clr.text, fontSize: 13, lineHeight: 1.5,
                    border: msg.role === 'user' ? 'none' : `1px solid ${clr.border}`,
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div style={{ alignSelf: 'flex-start', color: clr.faint, fontSize: 13 }}>⚡ Thinking…</div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div style={{
              padding: 10, borderTop: `1px solid ${clr.border}`,
              display: 'flex', gap: 8,
            }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendChatMessage())}
                placeholder="Ask a question…"
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8,
                  border: `1px solid ${clr.border}`, background: '#0b1220',
                  color: clr.text, fontSize: 13, outline: 'none',
                }}
              />
              <button
                onClick={sendChatMessage}
                disabled={!chatInput.trim() || chatLoading}
                style={{
                  padding: '8px 14px', borderRadius: 8,
                  background: chatInput.trim() && !chatLoading ? clr.blue : clr.faint,
                  border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                }}
              >
                ↑
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setChatOpen(true)}
            style={{
              width: 54, height: 54, borderRadius: '50%',
              background: clr.blue, border: 'none',
              color: '#fff', fontSize: 22, cursor: 'pointer',
              boxShadow: '0 4px 20px #3b82f640',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Ask the AI guide"
          >
            ⚡
          </button>
        )}
      </div>
    </div>
  )
}

import React, { useState, useMemo } from 'react'
import type { Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from './Spinner.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

// Contextual, lightweight AI — the capabilities that used to live on the separate
// "AI Tools" page, re-homed into the hub where the work actually happens:
//   research → Prospects ("qualify a business")
//   outreach → Outreach   ("draft a cold email")
//   reply    → Inbox      ("analyze a reply")
// Each is a collapsed button that expands into a minimal form, calls the existing
// synchronous /api/ai/* endpoint, and renders the result inline (clean, copyable) —
// no new routes, no DB writes, nothing persisted. It complements the per-lead
// Research/Outreach actions in Leads (those operate on a saved lead; this is the
// ad-hoc path for something not yet in the pipeline).

export type AiQuickActionKind = 'research' | 'outreach' | 'reply'

type Props = {
  kind: AiQuickActionKind
  api: ApiHook
  workspace: Workspace | null
  toast: ToastHook
}

type Field = { key: string; label: string; placeholder?: string; required?: boolean; multiline?: boolean }

const KIND_META: Record<AiQuickActionKind, { icon: string; cta: string; title: string; blurb: string; fields: Field[] }> = {
  research: {
    icon: '✦', cta: 'Qualify a business with AI', title: 'Qualify a business',
    blurb: 'Generate an ICP fit read, summary, and outreach angle for any business — before it’s even a lead.',
    fields: [
      { key: 'businessName', label: 'Business name', placeholder: 'Acme Plumbing Brisbane', required: true },
      { key: 'website', label: 'Website', placeholder: 'https://acmeplumbing.com.au' },
      { key: 'notes', label: 'Notes', placeholder: 'Saw them at BNI, growing fast' },
    ],
  },
  outreach: {
    icon: '✉', cta: 'Draft a cold email with AI', title: 'Draft a cold email',
    blurb: 'Write a personalised first-touch email and follow-up for a business.',
    fields: [
      { key: 'businessName', label: 'Business name', placeholder: 'Acme Plumbing Brisbane', required: true },
      { key: 'category', label: 'Category / industry', placeholder: 'Plumbing, Real Estate, Accounting…' },
      { key: 'outreachAngle', label: 'Angle (optional)', placeholder: 'Coordinating crews as they scale' },
    ],
  },
  reply: {
    icon: '◎', cta: 'Analyze a reply with AI', title: 'Analyze a reply',
    blurb: 'Summarise an inbound reply, classify its intent, and suggest the next move.',
    fields: [
      { key: 'replyBody', label: 'Paste the reply', placeholder: 'Thanks for reaching out, we’re not interested right now…', required: true, multiline: true },
    ],
  },
}

const INTENT_LABEL: Record<string, string> = {
  INTERESTED: 'Interested', REFERRAL: 'Referral', NEEDS_MORE_INFO: 'Needs info',
  NOT_NOW: 'Not now', OUT_OF_OFFICE: 'Auto-reply', NOT_INTERESTED: 'Not interested',
}
const ACTION_NEXT_STEP: Record<string, string> = {
  auto_draft: 'Strong fit — ready to draft outreach.',
  manual_review_then_draft: 'Promising but unconfirmed — review, then draft.',
  skip: 'Not a strong enough fit — skip for now.',
}

// Loosely-typed AI payloads — the endpoints return validated shapes, but the web
// only reads a handful of fields, so a permissive record keeps this decoupled.
type AnyResult = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

export function AiQuickAction({ kind, api, workspace, toast }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const meta = KIND_META[kind]
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AnyResult | null>(null)
  const [rationale, setRationale] = useState<AnyResult | null>(null)

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues(p => ({ ...p, [key]: e.target.value }))

  const missingRequired = meta.fields.some(f => f.required && !(values[f.key] ?? '').trim())

  async function run() {
    if (!workspace) { toast.error('No workspace selected'); return }
    if (missingRequired) { toast.error('Fill in the required field first'); return }
    setLoading(true)
    setResult(null)
    setRationale(null)
    try {
      const wsId = workspace.id
      const asResult = (v: unknown): AnyResult | null => (v && typeof v === 'object' ? v as AnyResult : null)
      // The shared route contract types these AI responses loosely (result as a
      // string, no scoreRationale) though the API returns richer objects — read
      // them through a permissive envelope, the same shape AiTools relied on.
      type AiEnvelope = { result?: unknown; scoreRationale?: unknown }
      let res: AnyResult | null = null
      if (kind === 'research') {
        const d = await route('POST /api/ai/research', { body: {
          workspaceId: wsId,
          businessName: values.businessName.trim(),
          website: (values.website ?? '').trim() || undefined,
          notes: (values.notes ?? '').trim() || undefined,
        } }) as AiEnvelope
        res = asResult(d.result)
        setRationale(asResult(d.scoreRationale))
      } else if (kind === 'outreach') {
        const d = await route('POST /api/ai/outreach', { body: {
          workspaceId: wsId,
          businessName: values.businessName.trim(),
          category: (values.category ?? '').trim() || undefined,
          outreachAngle: (values.outreachAngle ?? '').trim() || undefined,
        } }) as AiEnvelope
        res = asResult(d.result)
      } else {
        const d = await route('POST /api/ai/reply-analysis', { body: {
          workspaceId: wsId,
          replyBody: values.replyBody.trim(),
        } }) as AiEnvelope
        res = asResult(d.result)
      }
      setResult(res)
      if (!res) toast.error('The AI returned an unexpected result')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI request failed')
    } finally {
      setLoading(false)
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Copy failed'))
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...s.btnSm, background: '#1e293b', color: colors.text, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span aria-hidden="true">{meta.icon}</span> {meta.cta}
      </button>
    )
  }

  return (
    <div style={{ ...s.card, border: `1px solid ${colors.blue}55` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ color: colors.text, fontWeight: 700, fontSize: 14 }}>{meta.icon} {meta.title}</span>
        <button
          onClick={() => { setOpen(false); setResult(null); setRationale(null) }}
          aria-label="Close"
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: colors.textFaint, cursor: 'pointer', fontSize: 16 }}
        >
          ✕
        </button>
      </div>
      <p style={{ color: colors.textFaint, fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>{meta.blurb}</p>

      <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
        {meta.fields.map(f => (
          <div key={f.key}>
            <label style={s.label} htmlFor={`aiqa-${kind}-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
            {f.multiline ? (
              <textarea id={`aiqa-${kind}-${f.key}`} style={{ ...s.textarea, height: 120 }} value={values[f.key] ?? ''} onChange={set(f.key)} placeholder={f.placeholder} />
            ) : (
              <input id={`aiqa-${kind}-${f.key}`} style={s.input} value={values[f.key] ?? ''} onChange={set(f.key)} placeholder={f.placeholder} />
            )}
          </div>
        ))}
      </div>

      <button
        style={{ ...s.btn, opacity: loading || missingRequired ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 8 }}
        disabled={loading || missingRequired}
        onClick={run}
      >
        {loading ? <Spinner size={14} color="#fff" /> : meta.icon}
        {loading ? 'Thinking…' : `Run ${meta.title.toLowerCase()}`}
      </button>

      {result && (
        <div style={{ ...s.cardInner, marginTop: 16 }}>
          {kind === 'research' && <ResearchResult result={result} rationale={rationale} />}
          {kind === 'outreach' && <OutreachResult result={result} onCopy={copy} />}
          {kind === 'reply' && <ReplyResult result={result} />}
        </div>
      )}
    </div>
  )
}

function ResearchResult({ result, rationale }: { result: AnyResult; rationale: AnyResult | null }) {
  const summary = str(result.aiSummary)
  const angle = str(result.outreachAngle)
  const score = num(result.icpScore) ?? num(rationale?.score)
  const confidence = str(result.confidence)
  const action = str(result.recommendedAction)
  const risks = Array.isArray(result.riskFlags) ? (result.riskFlags as unknown[]).filter((r): r is string => typeof r === 'string') : []
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: colors.text, fontWeight: 700, fontSize: 13 }}>AI read</span>
        {typeof score === 'number' && <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>ICP fit {score}/100</span>}
        {confidence && <span style={s.badge(colors.textFaint)}>{confidence} confidence</span>}
      </div>
      {summary && <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{summary}</div>}
      {angle && (
        <div>
          <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Best way in</div>
          <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{angle}</div>
        </div>
      )}
      {risks.length > 0 && (
        <div>
          <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Worth knowing</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: colors.amber, fontSize: 13, lineHeight: 1.7 }}>
            {risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {action && (
        <div style={{ color: colors.textMuted, fontSize: 13 }}>
          <span style={{ color: colors.textFaint }}>Suggested next step — </span>{ACTION_NEXT_STEP[action] ?? action}
        </div>
      )}
    </div>
  )
}

function OutreachResult({ result, onCopy }: { result: AnyResult; onCopy: (t: string) => void }) {
  const subject = str(result.subject)
  const email = str(result.email)
  const followup = str(result.followup)
  const full = [subject && `Subject: ${subject}`, email, followup && `\nFollow-up:\n${followup}`].filter(Boolean).join('\n')
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: colors.text, fontWeight: 700, fontSize: 13 }}>Draft</span>
        <button style={{ ...s.btnSm, marginLeft: 'auto' }} onClick={() => onCopy(full)}>Copy all</button>
      </div>
      {subject && <div style={{ color: colors.text, fontWeight: 600, fontSize: 13 }}>{subject}</div>}
      {email && <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{email}</div>}
      {followup && (
        <div style={{ marginTop: 4, paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
          <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 4 }}>FOLLOW-UP</div>
          <div style={{ color: colors.textMuted, fontSize: 13, whiteSpace: 'pre-wrap' }}>{followup}</div>
        </div>
      )}
    </div>
  )
}

function ReplyResult({ result }: { result: AnyResult }) {
  const classification = str(result.classification)
  const summary = str(result.summary)
  const suggested = str(result.suggestedAction)
  const quote = str(result.keyQuote)
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: colors.text, fontWeight: 700, fontSize: 13 }}>Reply read</span>
        {classification && <span style={s.badge(colors.blue)}>{INTENT_LABEL[classification] ?? classification}</span>}
      </div>
      {summary && <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{summary}</div>}
      {quote && (
        <div style={{ borderLeft: `2px solid ${colors.border}`, paddingLeft: 10, color: colors.textFaint, fontSize: 13, fontStyle: 'italic' }}>
          “{quote}”
        </div>
      )}
      {suggested && (
        <div style={{ color: colors.blueLight, fontSize: 13 }}>
          <span style={{ color: colors.textFaint }}>Suggested next action — </span>{suggested}
        </div>
      )}
    </div>
  )
}

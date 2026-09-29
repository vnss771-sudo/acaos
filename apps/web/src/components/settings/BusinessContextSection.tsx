import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

// Mirrors BUSINESS_CONTEXT_MAX in backend-core/services/openai.ts.
const BUSINESS_CONTEXT_MAX = 4000

const PLACEHOLDER = `e.g.
What we do: Shopify store builds and CRO for DTC brands doing $1–10M/yr.
Pricing: Starter audit $1,500 flat; retainers from $4k/month.
Proof: Took Acme Coffee from 1.8% to 3.1% conversion in 90 days.
FAQs: We don't do paid ads. Typical build is 6–8 weeks. We work with UK and US clients.
Tone: plain-spoken, no jargon, sign off with first name.`

export function BusinessContextSection({ value, setValue, saving, onSave }: {
  value: string
  setValue: (v: string) => void
  saving: boolean
  onSave: () => void
}) {
  const over = value.length > BUSINESS_CONTEXT_MAX
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Business context for AI</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
        Tell the AI about your business: what you offer, pricing, proof points, common questions, and how you like to sound.
        It's used when analyzing replies, researching leads, and drafting outreach, so suggestions use your real details
        instead of generic ones. Don't include passwords or customer personal data.
      </div>
      <div style={{ maxWidth: 640, marginBottom: 16 }}>
        <label style={s.label} htmlFor="settings-business-context">About your business</label>
        <textarea id="settings-business-context"
          style={{ ...s.textarea, minHeight: 180 }}
          placeholder={PLACEHOLDER}
          value={value}
          onChange={e => setValue(e.target.value)}
          aria-describedby="settings-business-context-count"
        />
        <div id="settings-business-context-count" style={{ fontSize: 12, marginTop: 4, color: over ? colors.red : colors.textMuted }}>
          {value.length.toLocaleString()} / {BUSINESS_CONTEXT_MAX.toLocaleString()} characters
        </div>
      </div>
      <button style={s.btn} disabled={saving || over} onClick={onSave}>
        {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save business context'}
      </button>
    </div>
  )
}

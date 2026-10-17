import React, { useEffect, useRef, useState } from 'react'
import type { EstimateInputs, QuotingDefaults } from '@acaos/shared'
import type { RouteApi } from '../../lib/routeApi.js'
import { colors, s } from '../../styles.js'
import { formatCents, parseDollars } from '../../lib/money.js'

// The estimate builder inside Record quote: what this price leaves after the
// costs entered, and what price a target margin needs. The figures come from
// the server (POST /api/delivery/estimate, lib/quoteEstimate.ts) so there is one
// financial model. Advisory and editable: the buttons here only fill the quote
// form's fields; nothing is saved or sent until the user saves the quote.

export type EstimateResult = {
  labourCostCents: number | null
  labourIncludesOnCosts: boolean
  materialsCents: number | null
  subcontractCents: number | null
  directCostCents: number | null
  knownDirectCostCents: number
  overheadCents: number | null
  totalCostCents: number | null
  priceCents: number | null
  grossMarginCents: number | null
  grossMarginPct: number | null
  marginAfterOverheadsCents: number | null
  marginAfterOverheadsPct: number | null
  targetMarginPct: number | null
  priceForTargetCents: number | null
  trackRecord: null | { hoursFactor: number; adjustedHours: number; grossMarginCents: number | null; grossMarginPct: number | null; marginAfterOverheadsCents: number | null }
  gaps: string[]
}
type CrewRates = { activeCrew: number; ratedCrew: number; medianBaseRate: number | null }

export type Fields = { rate: string; onCost: string; materials: string; subcontract: string; overhead: string; target: string }
const EMPTY: Fields = { rate: '', onCost: '', materials: '', subcontract: '', overhead: '', target: '' }

/** Blank → null (not entered); a number → that number; anything else → NaN. */
function parseNumber(input: string): number | null {
  const t = input.replace(/[%$,\s]/g, '')
  if (t === '') return null
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN
}

/** The form's text fields as estimate inputs, or the first field that is not a number. */
export function toInputs(hours: string, f: Fields): { inputs: EstimateInputs } | { invalid: string } {
  const values: Array<[string, number | null]> = [
    ['Estimated labour hours', parseNumber(hours)], ['Labour rate', parseNumber(f.rate)], ['On-costs', parseNumber(f.onCost)],
    ['Materials', parseDollars(f.materials)], ['Subcontractors', parseDollars(f.subcontract)],
    ['Overheads', parseNumber(f.overhead)], ['Target margin', parseNumber(f.target)],
  ]
  const bad = values.find(([, v]) => v != null && Number.isNaN(v))
  if (bad) return { invalid: bad[0] }
  const [labourHours, labourRate, onCostPct, materialsCents, subcontractCents, overheadPct, targetMarginPct] = values.map(([, v]) => v)
  if (targetMarginPct != null && targetMarginPct > 95) return { invalid: 'Target margin' }
  return { inputs: { labourHours, labourRate, onCostPct, materialsCents, subcontractCents, overheadPct, targetMarginPct } }
}

const DEFAULT_FIELDS: Array<[keyof Fields, keyof QuotingDefaults]> = [
  ['onCost', 'defaultOnCostPct'], ['overhead', 'defaultOverheadPct'], ['target', 'defaultTargetMarginPct'],
]
const DEFAULT_LABEL: Partial<Record<keyof Fields, string>> = { onCost: 'On-costs', overhead: 'Overheads', target: 'Target margin' }

/** Copy set defaults into blank, untouched fields. null (not set) leaves the field blank; 0 fills "0". */
export function applyDefaults(prev: Fields, d: QuotingDefaults, touched: ReadonlySet<keyof Fields>, report: (keys: Array<keyof Fields>) => void): Fields {
  const next = { ...prev }
  const filled: Array<keyof Fields> = []
  for (const [field, key] of DEFAULT_FIELDS) {
    const v = d[key]
    if (v != null && Number.isFinite(v) && !touched.has(field) && prev[field] === '') { next[field] = String(v); filled.push(field) }
  }
  report(filled)
  return next
}

const isEmpty = (i: EstimateInputs) => Object.values(i).every(v => v == null)
const pctText = (p: number | null) => (p == null ? '—' : `${p}%`)

type Props = {
  route: RouteApi
  workspaceId: string
  target: { opportunityId: string } | { commercialOpportunityId: string }
  // From the quote form: the price being considered (cents; null blank; NaN invalid) and the hours text.
  priceCents: number | null
  hours: string
  onUsePrice: (cents: number) => void
  // The current inputs for saving with the quote; null when nothing is entered or a field is invalid.
  onInputs: (inputs: EstimateInputs | null) => void
}

export function EstimateBuilder({ route, workspaceId, target, priceCents, hours, onUsePrice, onInputs }: Props) {
  const [f, setF] = useState<Fields>(EMPTY)
  // Quoting defaults are copied in ONCE, when the builder opens: a snapshot, never a
  // live link, so an admin changing them mid-quote can't move figures being worked
  // on. Only blank fields the user hasn't touched are filled; unset stays blank.
  const touched = useRef(new Set<keyof Fields>())
  const [fromDefaults, setFromDefaults] = useState<Array<keyof Fields>>([])
  useEffect(() => {
    let live = true
    route('GET /api/workspaces/:id/quoting-defaults', { params: { id: workspaceId } })
      .then(r => { if (live && r?.defaults) setF(prev => applyDefaults(prev, r.defaults, touched.current, setFromDefaults)) })
      .catch(() => { /* no defaults: the fields simply start blank */ })
    return () => { live = false }
    // Once per builder: the snapshot above.
  }, [])
  const [result, setResult] = useState<{ estimate: EstimateResult; crewRates: CrewRates } | null>(null)
  const [failed, setFailed] = useState(false)
  const parsed = toInputs(hours, f)
  const inputsKey = JSON.stringify('inputs' in parsed ? parsed.inputs : null)
  const price = priceCents != null && Number.isNaN(priceCents) ? null : priceCents

  useEffect(() => {
    const inputs = 'inputs' in parsed ? parsed.inputs : null
    onInputs(inputs && !isEmpty(inputs) ? inputs : null)
    if (!inputs) return
    let live = true
    const timer = setTimeout(() => {
      route('POST /api/delivery/estimate', { body: { workspaceId, ...target, priceCents: price, inputs } })
        .then(r => { if (live) { setResult(r as { estimate: EstimateResult; crewRates: CrewRates }); setFailed(false) } })
        .catch(() => { if (live) setFailed(true) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
    // inputsKey stands for the parsed inputs; target is fixed for the card.
  }, [inputsKey, price, workspaceId])

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => {
    touched.current.add(k)
    setF(prev => ({ ...prev, [k]: e.target.value }))
  }
  const field = (k: keyof Fields, label: string, placeholder: string) => (
    <div>
      <label style={s.label} htmlFor={`est-${k}`}>{label}</label>
      <input id={`est-${k}`} style={{ ...s.input, width: 120 }} inputMode="decimal" value={f[k]} placeholder={placeholder} onChange={set(k)} />
    </div>
  )
  const e = result?.estimate
  const median = result?.crewRates.medianBaseRate ?? null

  return (
    <div data-testid="estimate-builder" style={{ flexBasis: '100%', display: 'grid', gap: 8, padding: 10, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {field('rate', 'Labour rate ($/h)', median != null ? String(median) : '55')}
        {field('onCost', 'On-costs (%)', '25')}
        {field('materials', 'Materials ($)', '15,000')}
        {field('subcontract', 'Subcontractors ($)', '5,000')}
        {field('overhead', 'Overheads (% of direct)', '10')}
        {field('target', 'Target gross margin (%)', '25')}
      </div>
      {fromDefaults.length > 0 && (
        <span data-testid="estimate-defaults-note" style={{ fontSize: 12, color: colors.textFaint }}>
          {fromDefaults.map(k => DEFAULT_LABEL[k]).join(', ')} filled in from your quoting defaults. Change them here for this quote only.
        </span>
      )}
      {result && (
        <span style={{ fontSize: 12, color: colors.textFaint }}>
          {median != null
            ? <>Crew median base rate ${median}/h ({result.crewRates.ratedCrew} of {result.crewRates.activeCrew} active crew have a rate). <button style={s.btnGhost} onClick={() => setF(prev => ({ ...prev, rate: String(median) }))}>Use it</button></>
            : `No active crew have a base rate recorded, so there is no rate to suggest.`}
        </span>
      )}
      {'invalid' in parsed && <span role="alert" style={{ fontSize: 12, color: colors.amber }}>{parsed.invalid} must be a number{parsed.invalid === 'Target margin' ? ' up to 95' : ''}.</span>}
      {failed && <span style={{ fontSize: 12, color: colors.textFaint }}>Couldn't calculate the estimate just now. The quote can still be saved.</span>}
      {e && 'inputs' in parsed && (
        <div role="region" aria-label="Estimate" style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span>
            Labour <strong>{formatCents(e.labourCostCents)}</strong>{e.labourCostCents != null && !e.labourIncludesOnCosts ? ' (base pay only)' : ''}
            {' · '}Materials <strong>{formatCents(e.materialsCents)}</strong>
            {' · '}Subcontractors <strong>{formatCents(e.subcontractCents)}</strong>
            {' · '}Direct cost <strong>{e.directCostCents != null ? formatCents(e.directCostCents) : `unknown (${formatCents(e.knownDirectCostCents)} entered so far)`}</strong>
            {e.totalCostCents != null && <> · Break-even incl. overheads <strong>{formatCents(e.totalCostCents)}</strong></>}
          </span>
          {e.grossMarginCents != null && (
            <span style={{ color: e.grossMarginCents < 0 ? colors.red : colors.text }}>
              At {formatCents(e.priceCents)}: gross margin <strong>{formatCents(e.grossMarginCents)} ({pctText(e.grossMarginPct)})</strong>
              {e.marginAfterOverheadsCents != null && <> · after overheads {formatCents(e.marginAfterOverheadsCents)} ({pctText(e.marginAfterOverheadsPct)})</>}
            </span>
          )}
          {e.trackRecord?.grossMarginCents != null && (
            <span style={{ color: colors.amber }}>
              If labour runs like your recent comparable jobs ({e.trackRecord.adjustedHours} h): gross margin {formatCents(e.trackRecord.grossMarginCents)} ({pctText(e.trackRecord.grossMarginPct)})
              {e.trackRecord.marginAfterOverheadsCents != null && <>, after overheads {formatCents(e.trackRecord.marginAfterOverheadsCents)}</>}.
            </span>
          )}
          {e.priceForTargetCents != null && (
            <span>
              For a {e.targetMarginPct}% gross margin, quote at least <strong>{formatCents(e.priceForTargetCents)}</strong>.{' '}
              <button style={s.btnGhost} onClick={() => onUsePrice(e.priceForTargetCents!)}>Use this price</button>
            </span>
          )}
          {e.gaps.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: colors.textFaint }}>
              {e.gaps.map(g => <li key={g}>{g}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

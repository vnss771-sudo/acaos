// How well the AI reply classifier is doing for a workspace, measured only from
// the replies a person reviewed in the Inbox (👍 / 👎 with the right label).
// It turns those verdicts into accuracy, the labels it gets wrong most often
// (drift), and a concrete suggestion when confident "not interested" calls keep
// being overturned: each of those leads was automatically marked dead.
//
// Honest numbers: below MIN_REVIEWED verdicts accuracy and the suggestion are
// withheld with the reason, never shown as a confident figure. Pure, so the
// arithmetic is unit-tested without a database.

export const MIN_REVIEWED = 5

export type ReviewedReply = {
  predicted: string
  confidence: number | null
  feedback: 'CORRECT' | 'INCORRECT' | 'UNSURE'
  corrected: string | null
}

export type LabelAccuracy = { label: string; reviewed: number; wrong: number; topCorrection: { to: string; count: number } | null }

export type ClassificationAccuracy = {
  reviewed: number
  correct: number
  incorrect: number
  unsure: number
  /** correct / (correct + incorrect), 0–1; null below MIN_REVIEWED decided verdicts. */
  accuracy: number | null
  withheldReason: string | null
  labels: LabelAccuracy[]
  mistakes: Array<{ from: string; to: string; count: number }>
  overturnedNegatives: { count: number; aboveFloor: number; floor: number }
  recommendation: string | null
}

const LABEL_TEXT: Record<string, string> = {
  INTERESTED: 'interested', NOT_INTERESTED: 'not interested', NEEDS_MORE_INFO: 'needs info',
  NOT_NOW: 'not now', REFERRAL: 'referral', OUT_OF_OFFICE: 'auto-reply',
}
const text = (l: string) => LABEL_TEXT[l] ?? l.toLowerCase()

export function computeClassificationAccuracy(rows: ReviewedReply[], confidenceFloor: number): ClassificationAccuracy {
  const correct = rows.filter(r => r.feedback === 'CORRECT').length
  const wrongRows = rows.filter(r => r.feedback === 'INCORRECT' && r.corrected && r.corrected !== r.predicted)
  const incorrect = wrongRows.length
  const unsure = rows.filter(r => r.feedback === 'UNSURE').length
  const decided = correct + incorrect
  const enough = decided >= MIN_REVIEWED

  const byLabel = new Map<string, { reviewed: number; wrong: number; to: Map<string, number> }>()
  for (const r of rows) {
    if (r.feedback === 'UNSURE') continue
    const e = byLabel.get(r.predicted) ?? { reviewed: 0, wrong: 0, to: new Map<string, number>() }
    e.reviewed++
    if (r.feedback === 'INCORRECT' && r.corrected && r.corrected !== r.predicted) {
      e.wrong++
      e.to.set(r.corrected, (e.to.get(r.corrected) ?? 0) + 1)
    }
    byLabel.set(r.predicted, e)
  }
  const labels: LabelAccuracy[] = [...byLabel.entries()].map(([label, e]) => {
    const top = [...e.to.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    return { label, reviewed: e.reviewed, wrong: e.wrong, topCorrection: top ? { to: top[0], count: top[1] } : null }
  }).sort((a, b) => b.wrong - a.wrong || b.reviewed - a.reviewed || a.label.localeCompare(b.label))

  const pairs = new Map<string, number>()
  for (const r of wrongRows) pairs.set(`${r.predicted}>${r.corrected}`, (pairs.get(`${r.predicted}>${r.corrected}`) ?? 0) + 1)
  const mistakes = [...pairs.entries()]
    .map(([k, count]) => { const [from, to] = k.split('>'); return { from, to, count } })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
    .slice(0, 5)

  // Negatives a person overturned. Those at/above the floor were acted on
  // automatically (lead marked dead); those below it were already held back.
  const overturned = wrongRows.filter(r => r.predicted === 'NOT_INTERESTED')
  const overturnedAbove = overturned.filter(r => (r.confidence ?? 0) >= confidenceFloor)

  let recommendation: string | null = null
  if (enough && overturnedAbove.length >= 2) {
    const highest = Math.max(...overturnedAbove.map(r => r.confidence ?? 0))
    const proposed = Math.min(95, Math.ceil((highest + 1) / 5) * 5)
    if (proposed > confidenceFloor) {
      // The cost of the change, stated with it: correct negatives that would
      // also be held for a person instead of closing automatically.
      const alsoHeld = rows.filter(r => r.predicted === 'NOT_INTERESTED' && r.feedback === 'CORRECT'
        && (r.confidence ?? 0) >= confidenceFloor && (r.confidence ?? 0) < proposed).length
      recommendation = `${overturnedAbove.length} replies labelled "not interested" at ${confidenceFloor}%+ confidence were overturned — `
        + `each of those leads had been marked dead automatically. Setting REPLY_CLASSIFICATION_MIN_CONFIDENCE to ${proposed} `
        + `would have kept them for review`
        + (alsoHeld > 0 ? `; ${alsoHeld} correct "not interested" ${alsoHeld === 1 ? 'reply' : 'replies'} would also have waited for a person.` : '.')
    }
  }

  return {
    reviewed: rows.length,
    correct,
    incorrect,
    unsure,
    accuracy: enough ? correct / decided : null,
    withheldReason: enough ? null : `Needs at least ${MIN_REVIEWED} replies marked right or wrong (${decided} so far)`,
    labels,
    mistakes,
    overturnedNegatives: { count: overturned.length, aboveFloor: overturnedAbove.length, floor: confidenceFloor },
    recommendation,
  }
}

/** "not now → interested" — for summaries. */
export function describeMistake(m: { from: string; to: string }): string {
  return `${text(m.from)} → ${text(m.to)}`
}

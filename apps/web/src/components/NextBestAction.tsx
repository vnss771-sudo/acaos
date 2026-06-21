import React from 'react'
import type { StatsData, View } from '../types.js'
import { s, colors } from '../styles.js'

// Acquisition Radar — "Next Best Action" hero. The packs' top ask was to put a
// single, decisive next step above the passive analytics. This derives that one
// action from data the dashboard already fetches (no extra request), so the
// operator always knows what to do the moment Radar loads.

export type NbaTone = 'blue' | 'green' | 'amber' | 'red'

export type NextBestAction = {
  id: string
  title: string
  body: string
  cta: string
  view: View
  tone: NbaTone
}

type Input = {
  stats: StatsData | null
  hotCount: number
  signalCount: number
}

// First match wins, ordered by operator urgency: activate → build → revenue →
// opportunity → momentum.
export function computeNextBestAction({ stats, hotCount, signalCount }: Input): NextBestAction {
  if (!stats || stats.totalLeads === 0) {
    return {
      id: 'discover',
      title: 'Discover your first prospects',
      body: 'Your pipeline is empty. Find high-intent accounts that match your ideal customer.',
      cta: 'Find prospects',
      view: 'prospects',
      tone: 'blue',
    }
  }
  if (stats.campaignCount === 0) {
    return {
      id: 'mission',
      title: 'Launch your first mission',
      body: 'Set your target, offer, and playbook so ACAOS can discover, score, and draft outreach.',
      cta: 'Create a mission',
      view: 'missions',
      tone: 'blue',
    }
  }
  const replies = stats.funnel.REPLIED ?? 0
  if (replies > 0) {
    return {
      id: 'replies',
      title: `${replies} repl${replies === 1 ? 'y' : 'ies'} waiting on you`,
      body: 'Leads have responded. Follow up while interest is high.',
      cta: 'Review replies',
      view: 'leads',
      tone: 'green',
    }
  }
  if (hotCount > 0) {
    return {
      id: 'hot',
      title: `${hotCount} hot account${hotCount === 1 ? '' : 's'} ready for outreach`,
      body: 'These accounts show the strongest buying signals right now.',
      cta: 'Work hot accounts',
      view: 'prospects',
      tone: 'red',
    }
  }
  if (signalCount > 0) {
    return {
      id: 'signals',
      title: `${signalCount} new buying signal${signalCount === 1 ? '' : 's'}`,
      body: 'Fresh signals were detected. Review them to find your next opportunity.',
      cta: 'Review signals',
      view: 'intelligence',
      tone: 'amber',
    }
  }
  return {
    id: 'momentum',
    title: "You're all caught up",
    body: 'No urgent actions. Review mission performance or expand your prospect list.',
    cta: 'Open missions',
    view: 'missions',
    tone: 'blue',
  }
}

const TONE_COLOR: Record<NbaTone, string> = {
  blue: colors.blue,
  green: colors.green,
  amber: colors.amber,
  red: colors.red,
}

export function NextBestActionCard({ stats, hotCount, signalCount, setView }: Input & { setView: (v: View) => void }) {
  const nba = computeNextBestAction({ stats, hotCount, signalCount })
  const accent = TONE_COLOR[nba.tone]
  return (
    <div
      style={{
        ...s.card,
        borderColor: accent + '55',
        background: `linear-gradient(90deg, ${accent}14, transparent 60%)`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ color: accent, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
          Next best action
        </div>
        <div style={{ color: colors.text, fontSize: 18, fontWeight: 700 }}>{nba.title}</div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginTop: 2 }}>{nba.body}</div>
      </div>
      <button style={{ ...s.btn, background: accent }} onClick={() => setView(nba.view)}>
        {nba.cta} →
      </button>
    </div>
  )
}

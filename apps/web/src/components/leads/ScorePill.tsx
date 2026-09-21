import React from 'react'
import { s, colors } from '../../styles.js'
import { TIER_COLOR, getScoreTier } from '../../types.js'

export function ScorePill({ score }: { score: number }) {
  if (score <= 0) return <span style={{ color: colors.textFaint, fontSize: 13 }}>–</span>
  const tier = getScoreTier(score)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={s.badge(TIER_COLOR[tier])}>{tier}</span>
      <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>{score}</span>
    </span>
  )
}

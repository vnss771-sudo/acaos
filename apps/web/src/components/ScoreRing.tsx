import React from 'react'
import { getScoreTier, TIER_COLOR } from '../types.js'

export function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tier = getScoreTier(score)
  const color = TIER_COLOR[tier]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      background: color + '22'
    }}>
      <span style={{ color, fontWeight: 800, fontSize: size * 0.28 }}>{score}</span>
    </div>
  )
}

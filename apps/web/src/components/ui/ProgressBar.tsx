import React from 'react'
import { colors } from '../../styles.js'

type Props = {
  value: number
  max?: number
  /** Solid fill color (ignored if `gradient` is set). */
  color?: string
  /** Optional CSS gradient string for the fill (e.g. funnel/weight bars). */
  gradient?: string
  height?: number
  track?: string
}

// Single progress/meter bar — replaces the per-view FunnelBar / UsageMeter /
// WeightBar inline bar markup. Clamps to [0, 100]%.
export function ProgressBar({ value, max = 100, color = colors.blue, gradient, height = 8, track = colors.border }: Props) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      style={{ background: track, borderRadius: 999, height, overflow: 'hidden', width: '100%' }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: gradient ?? color, borderRadius: 999, transition: 'width 0.3s ease' }} />
    </div>
  )
}

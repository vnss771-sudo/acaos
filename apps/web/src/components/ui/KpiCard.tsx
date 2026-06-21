import React from 'react'
import { colors } from '../../styles.js'
import { Card } from './Card.js'

type Props = {
  label: string
  value: React.ReactNode
  sub?: string
  trend?: string
  /** Accent color for the big number (defaults to primary text). */
  color?: string
}

// KPI/metric tile — the recurring "label + big number + sub" pattern that views
// (Dashboard especially) re-implement inline. Mirrors the existing StatCard markup
// so migrations are text-identical.
export function KpiCard({ label, value, sub, trend, color = colors.text }: Props) {
  return (
    <Card>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>{sub}</div>}
      {trend && <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>{trend}</div>}
    </Card>
  )
}

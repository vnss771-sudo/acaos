import React from 'react'
import type { Workspace } from '../../types.js'
import { s, colors } from '../../styles.js'

export function WorkspaceInfoSection({ workspace }: { workspace: Workspace }) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Workspace Info</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'Workspace ID', value: workspace.id },
          { label: 'Plan', value: workspace.plan.charAt(0).toUpperCase() + workspace.plan.slice(1) },
          { label: 'Total Leads', value: String(workspace._count?.leads ?? '–') },
          { label: 'Total Campaigns', value: String(workspace._count?.campaigns ?? '–') }
        ].map(({ label, value }) => (
          <div key={label} style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
            <div style={{ color: colors.text, fontSize: 14, fontFamily: label === 'Workspace ID' ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

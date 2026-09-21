import React from 'react'
import { colors } from '../../styles.js'

export function JobProgressBar({ progress, state }: { progress: number; state: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    waiting: { color: colors.textFaint, label: 'Queued' },
    active: { color: colors.amber, label: `Processing…` },
    completed: { color: colors.green, label: 'Complete' },
    failed: { color: colors.red, label: 'Failed' }
  }
  const c = cfg[state] ?? cfg.waiting
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: c.color, fontSize: 12, fontWeight: 600 }}>{c.label}</span>
        {state === 'active' && <span style={{ color: colors.textFaint, fontSize: 11 }}>{progress}%</span>}
      </div>
      {state === 'active' && (
        <div style={{ background: '#1e2d40', borderRadius: 3, height: 3, overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: colors.amber, borderRadius: 3, transition: 'width 0.4s' }} />
        </div>
      )}
    </div>
  )
}

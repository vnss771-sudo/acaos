import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { View } from '../types.js'
import { colors } from '../styles.js'

// ⌘K / Ctrl+K / "/" command palette. Self-contained: owns its open state and the
// global key listener, renders nothing until opened. Built on the app's JS tokens
// (not a CSS framework) so it matches the rest of the shell and stays CSP-safe.

type Command = {
  id: View
  label: string
  description: string
  icon: string
  adminOnly?: boolean
}

const COMMANDS: Command[] = [
  { id: 'dashboard', label: 'Acquisition Radar', description: 'Daily command center: next action, hot accounts, signals', icon: '⬡' },
  { id: 'missions', label: 'Missions', description: 'Build and run the end-to-end acquisition workflow', icon: '◇' },
  { id: 'prospects', label: 'Prospects', description: 'Account database, scoring, filters, and signals', icon: '◎' },
  { id: 'approvals', label: 'Review Queue', description: 'Approve AI outreach before it sends', icon: '✓' },
  { id: 'campaigns', label: 'Campaigns', description: 'Campaign configuration and sending', icon: '▣' },
  { id: 'inbox', label: 'Inbox', description: 'Replies to your outreach, classified by intent', icon: '✉' },
  { id: 'intelligence', label: 'Intelligence', description: 'Scoring model, opportunity tiers, forecasts', icon: '◈' },
  { id: 'leads', label: 'Leads', description: 'Lead list and outreach records', icon: '▤' },
  { id: 'ai', label: 'AI Tools', description: 'Research, write, and analyze replies manually', icon: '✦' },
  { id: 'billing', label: 'Billing', description: 'Plan, usage, and subscription status', icon: '◆' },
  { id: 'settings', label: 'Settings', description: 'Workspace, sender identity, SMTP, and team', icon: '◌' },
  { id: 'admin', label: 'Admin Panel', description: 'Platform administration', icon: '⚙', adminOnly: true },
]

export function CommandPalette({ setView, isAdmin = false }: { setView: (v: View) => void; isAdmin?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(o => !o)
      } else if (!typing && event.key === '/') {
        event.preventDefault()
        setOpen(true)
      } else if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Reset transient state each time the palette opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(id)
  }, [open])

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase()
    return COMMANDS
      .filter(c => !c.adminOnly || isAdmin)
      .filter(c => !q || `${c.label} ${c.description}`.toLowerCase().includes(q))
  }, [query, isAdmin])

  const run = (cmd: Command) => {
    setView(cmd.id)
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(a => Math.min(a + 1, commands.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(a => Math.max(a - 1, 0))
    } else if (event.key === 'Enter' && commands[active]) {
      event.preventDefault()
      run(commands[active])
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(640px, calc(100vw - 24px))', background: colors.bgCard,
          border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
          placeholder="Jump to a screen…"
          aria-label="Search commands"
          style={{
            width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none',
            background: 'transparent', color: colors.text, fontSize: 16, padding: '16px 18px',
            borderBottom: `1px solid ${colors.border}`,
          }}
        />
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: 6 }}>
          {commands.map((cmd, i) => (
            <button
              key={cmd.id}
              onClick={() => run(cmd)}
              onMouseEnter={() => setActive(i)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none',
                background: i === active ? colors.bgSurface : 'transparent', borderRadius: 8,
                padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 15, color: colors.textMuted, width: 20, textAlign: 'center' }}>{cmd.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', color: colors.text, fontWeight: 700, fontSize: 14 }}>{cmd.label}</span>
                <span style={{ display: 'block', color: colors.textFaint, fontSize: 12, marginTop: 1 }}>{cmd.description}</span>
              </span>
            </button>
          ))}
          {commands.length === 0 && (
            <div style={{ padding: 18, color: colors.textFaint, fontSize: 13 }}>No matching commands.</div>
          )}
        </div>
      </div>
    </div>
  )
}

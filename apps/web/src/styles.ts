import type React from 'react'

export const colors = {
  bg: '#030712',
  bgSurface: '#080e1a',
  bgCard: '#0d1626',
  bgElevated: '#111827',
  border: '#1e2d40',
  borderLight: '#1f2937',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#475569',
  textDisabled: '#374151',
  blue: '#2563eb',
  blueDark: '#1d4ed8',
  blueLight: '#3b82f6',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  redDark: '#7f1d1d',
  purple: '#8b5cf6'
}

export const s = {
  card: {
    background: colors.bgElevated,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: 12,
    padding: 20
  } as React.CSSProperties,

  cardInner: {
    background: '#0f172a',
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 14
  } as React.CSSProperties,

  input: {
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: '#0b1220',
    color: colors.text,
    width: '100%',
    boxSizing: 'border-box' as const,
    fontSize: 14,
    outline: 'none'
  } as React.CSSProperties,

  textarea: {
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: '#0b1220',
    color: colors.text,
    width: '100%',
    boxSizing: 'border-box' as const,
    fontSize: 14,
    resize: 'vertical' as const,
    outline: 'none',
    fontFamily: 'inherit'
  } as React.CSSProperties,

  btn: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: colors.blue,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    transition: 'background 0.15s'
  } as React.CSSProperties,

  btnSm: {
    padding: '6px 12px',
    borderRadius: 6,
    border: 'none',
    background: '#1f2937',
    color: colors.text,
    cursor: 'pointer',
    fontSize: 13
  } as React.CSSProperties,

  btnDanger: {
    padding: '6px 12px',
    borderRadius: 6,
    border: 'none',
    background: colors.redDark,
    color: '#fca5a5',
    cursor: 'pointer',
    fontSize: 13
  } as React.CSSProperties,

  btnGhost: {
    padding: '8px 14px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.textMuted,
    cursor: 'pointer',
    fontSize: 13
  } as React.CSSProperties,

  btnSuccess: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#16a34a',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600
  } as React.CSSProperties,

  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 4,
    display: 'block',
    fontWeight: 500,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const
  } as React.CSSProperties,

  sectionHeader: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom: 12
  } as React.CSSProperties,

  badge: (color: string): React.CSSProperties => ({
    background: color,
    color: '#fff',
    padding: '2px 8px',
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.03em',
    display: 'inline-block'
  }),

  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as React.CSSProperties,
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 } as React.CSSProperties,
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 } as React.CSSProperties,
  flex: { display: 'flex', alignItems: 'center', gap: 10 } as React.CSSProperties,
  flexBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as React.CSSProperties,
  stack: { display: 'grid', gap: 16 } as React.CSSProperties
}

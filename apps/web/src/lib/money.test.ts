import { describe, test, expect } from 'vitest'
import { formatCents, parseDollars, formatPct } from './money.js'

describe('money', () => {
  test('formats cents as whole dollars, unknown as a dash', () => {
    expect(formatCents(6_000_000)).toBe('$60,000')
    expect(formatCents(-10_050)).toBe('-$101')
    expect(formatCents(null)).toBe('—')
  })
  test('parses dollars to cents; blank is unknown, junk is NaN', () => {
    expect(parseDollars('$60,000')).toBe(6_000_000)
    expect(parseDollars('12.5')).toBe(1250)
    expect(parseDollars('  ')).toBeNull()
    expect(parseDollars('abc')).toBeNaN()
    expect(parseDollars('-5')).toBeNaN()
  })
  test('percentages carry a sign', () => {
    expect(formatPct(32.5)).toBe('+32.5%')
    expect(formatPct(-4)).toBe('-4%')
    expect(formatPct(0)).toBe('0%')
    expect(formatPct(null)).toBe('—')
  })
})

import { describe, it, expect } from 'vitest'
import { parseCsvLine, parseCsv } from './csv.js'

describe('parseCsvLine', () => {
  it('splits a plain comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('preserves a trailing empty field after a trailing comma', () => {
    expect(parseCsvLine('a,b,')).toEqual(['a', 'b', ''])
  })

  it('parses a single quoted field with no trailing comma (regression: no spurious trailing empty field)', () => {
    expect(parseCsvLine('"a"')).toEqual(['a'])
  })

  it('preserves a trailing empty field after a quoted field followed by a trailing comma', () => {
    expect(parseCsvLine('"a",')).toEqual(['a', ''])
  })

  it('parses a quoted field followed by an unquoted field', () => {
    expect(parseCsvLine('"a",b')).toEqual(['a', 'b'])
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('"a""b"')).toEqual(['a"b'])
  })

  it('keeps commas inside a quoted field as part of that field', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
  })

  it('handles a lone comma as two empty fields', () => {
    expect(parseCsvLine(',')).toEqual(['', ''])
  })

  it('handles a single unquoted field', () => {
    expect(parseCsvLine('a')).toEqual(['a'])
  })
})

describe('parseCsv', () => {
  it('parses a header row and data rows into objects', () => {
    expect(parseCsv('name,email\nAcme,a@acme.test\nBeta,b@beta.test')).toEqual([
      { name: 'Acme', email: 'a@acme.test' },
      { name: 'Beta', email: 'b@beta.test' },
    ])
  })

  it('handles a quoted last column without adding a phantom field', () => {
    // Regression coverage for the off-by-one: a quoted final column used to
    // leave a spurious empty extra value, silently shifting later parses.
    const rows = parseCsv('name,note\nAcme,"hello, world"')
    expect(rows).toEqual([{ name: 'Acme', note: 'hello, world' }])
  })

  it('returns an empty array for a header-only input', () => {
    expect(parseCsv('name,email')).toEqual([])
  })
})

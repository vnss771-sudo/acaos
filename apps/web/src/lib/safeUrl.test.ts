import { describe, test, expect } from 'vitest'
import { safeExternalUrl } from './safeUrl.js'

describe('safeExternalUrl', () => {
  test('keeps http(s) links', () => {
    expect(safeExternalUrl('https://tenders.gov.au/cn/1')).toBe('https://tenders.gov.au/cn/1')
    expect(safeExternalUrl(' http://example.test/a ')).toBe('http://example.test/a')
  })
  test('drops script, data and relative URLs', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeExternalUrl('/relative/path')).toBeNull()
    expect(safeExternalUrl('')).toBeNull()
    expect(safeExternalUrl(null)).toBeNull()
  })
})

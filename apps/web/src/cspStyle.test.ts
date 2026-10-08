import { beforeEach, describe, expect, it } from 'vitest'
import { classNameForStyle, transformStyleProps } from './cspStyle'

describe('strict CSP style runtime', () => {
  beforeEach(() => {
    document.head.innerHTML = '<style id="test-sheet"></style>'
  })

  it('removes the style prop and emits a generated class', () => {
    const result = transformStyleProps({ className: 'existing', style: { marginTop: 8, opacity: 0.5 } })
    expect(result).not.toHaveProperty('style')
    expect(result.className).toMatch(/^existing ac-/)
  })

  it('reuses the same class for equivalent style objects', () => {
    expect(classNameForStyle({ padding: 4 })).toBe(classNameForStyle({ padding: 4 }))
  })

  it('does not emit raw style attributes for empty styles', () => {
    expect(transformStyleProps({ style: {} })).toEqual({})
  })
})

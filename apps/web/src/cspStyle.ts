import type { CSSProperties } from 'react'

const unitless = new Set([
  'animation-iteration-count','aspect-ratio','border-image-outset','border-image-slice','border-image-width',
  'box-flex','box-flex-group','box-ordinal-group','column-count','columns','flex','flex-grow','flex-positive',
  'flex-shrink','flex-negative','flex-order','grid-area','grid-column','grid-column-end','grid-column-span',
  'grid-column-start','grid-row','grid-row-end','grid-row-span','grid-row-start','font-weight','line-clamp',
  'line-height','opacity','order','orphans','scale','tab-size','widows','z-index','zoom','fill-opacity',
  'flood-opacity','stop-opacity','stroke-dasharray','stroke-dashoffset','stroke-miterlimit','stroke-opacity',
  'stroke-width','-webkit-line-clamp'
])

const cache = new Map<string, string>()
const reverse = new Map<string, string>()
let sheet: CSSStyleSheet | null = null

function camelToKebab(input: string): string {
  if (input.startsWith('--')) return input
  return input
    .replace(/^ms-?/, '-ms-')
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
}

function normalizeValue(property: string, value: unknown): string | null {
  if (value == null || typeof value === 'boolean' || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (value === 0 || property.startsWith('--') || unitless.has(property)) return String(value)
    return `${value}px`
  }
  return String(value)
}

function serializeStyle(style: CSSProperties): string {
  if (typeof document === 'undefined') return ''
  const declaration = document.createElement('span').style

  for (const [rawProperty, rawValue] of Object.entries(style)) {
    const property = camelToKebab(rawProperty)
    const value = normalizeValue(property, rawValue)
    if (value == null) continue
    // CSSStyleDeclaration performs browser parsing/escaping, avoiding raw CSS
    // concatenation from style values while matching React's DOM semantics.
    declaration.setProperty(property, value)
  }

  return declaration.cssText
}

function ensureSheet(): CSSStyleSheet {
  if (sheet) return sheet
  if (typeof document === 'undefined') {
    throw new Error('ACAOS CSP style runtime requires a browser document')
  }

  const SheetCtor = globalThis.CSSStyleSheet
  if (SheetCtor && 'adoptedStyleSheets' in document && typeof SheetCtor.prototype.replaceSync === 'function') {
    const constructed = new SheetCtor()
    ;(document as Document & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [
      ...(document as Document & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets,
      constructed,
    ]
    sheet = constructed
    return sheet
  }

  // Fallback for older browsers: reuse an already-authorized same-origin
  // stylesheet. This remains compatible with style-src 'self' and does not
  // create an inline <style> element.
  for (const candidate of Array.from(document.styleSheets)) {
    try {
      void candidate.cssRules
      sheet = candidate
      return candidate
    } catch {
      // Cross-origin stylesheet; continue looking for a writable local sheet.
    }
  }

  throw new Error('ACAOS strict CSP could not acquire a writable stylesheet')
}

function hash(input: string): string {
  let value = 5381
  for (let i = 0; i < input.length; i += 1) {
    value = ((value << 5) + value) ^ input.charCodeAt(i)
  }
  return (value >>> 0).toString(36)
}

export function classNameForStyle(style: CSSProperties | null | undefined): string | undefined {
  if (!style || Object.keys(style).length === 0) return undefined
  const cssText = serializeStyle(style)
  if (!cssText) return undefined

  const existing = cache.get(cssText)
  if (existing) return existing

  const base = `ac-${hash(cssText)}`
  let className = base
  let suffix = 1
  while (reverse.has(className) && reverse.get(className) !== cssText) {
    className = `${base}-${suffix++}`
  }

  ensureSheet().insertRule(`.${className}{${cssText}}`)
  cache.set(cssText, className)
  reverse.set(className, cssText)
  return className
}

export function transformStyleProps<P extends Record<string, unknown> | null>(props: P): P {
  if (!props || !Object.prototype.hasOwnProperty.call(props, 'style')) return props

  const style = props.style
  if (style == null) {
    const { style: _style, ...rest } = props
    return rest as P
  }
  if (typeof style !== 'object' || Array.isArray(style)) {
    throw new Error('ACAOS strict CSP only supports React style objects')
  }

  const generated = classNameForStyle(style as CSSProperties)
  const { style: _style, className, ...rest } = props
  const mergedClassName = [typeof className === 'string' ? className : undefined, generated]
    .filter(Boolean)
    .join(' ') || undefined

  return {
    ...rest,
    ...(mergedClassName ? { className: mergedClassName } : {}),
  } as P
}

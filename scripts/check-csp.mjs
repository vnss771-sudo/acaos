#!/usr/bin/env node
// Strict-CSP drift gate. The production policy (nginx.conf) allows no inline
// styles or scripts. React style={{}} props are fine (applied via the CSSOM), so
// this gate guards the things CSP would actually block: a loosened policy, raw
// style-attribute or <style> writes in web code, inline markup in index.html,
// and the browser-level enforcement test being unwired.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = process.cwd()
const read = (p) => readFileSync(resolve(root, p), 'utf8')
const failures = []

const nginx = read('nginx.conf')
const csp = nginx.split(/\n\s*location\s/)[0].match(/^\s*add_header\s+Content-Security-Policy\s+"([^"]*)"/m)?.[1]
if (!csp) {
  failures.push('nginx.conf: no server-level Content-Security-Policy header')
} else {
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]))
  if (csp.includes('unsafe-inline') || csp.includes('unsafe-eval')) failures.push("nginx.conf: CSP must not contain 'unsafe-inline' or 'unsafe-eval'")
  const expect = { 'script-src': ["'self'"], 'style-src': ["'self'"], 'style-src-elem': ["'self'"], 'style-src-attr': ["'none'"], 'frame-ancestors': ["'none'"] }
  for (const [name, value] of Object.entries(expect)) {
    if (directives[name]?.join(' ') !== value.join(' ')) failures.push(`nginx.conf: CSP ${name} must be ${value.join(' ')} (found ${directives[name]?.join(' ') ?? 'missing'})`)
  }
}

// Writes that bypass React's CSSOM style handling and that CSP blocks or that
// would tempt re-adding 'unsafe-inline'.
const forbidden = [
  [/setAttribute\(\s*['"`]style['"`]/, "setAttribute('style', ...)"],
  [/\.cssText\s*=/, 'style.cssText assignment'],
  [/createElement\(\s*['"`]style['"`]/, "createElement('style')"],
  [/\binsertRule\s*\(/, 'CSSStyleSheet.insertRule'],
  [/\.(?:inner|outer)HTML\s*=/, 'innerHTML/outerHTML assignment'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
]
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) yield* walk(abs)
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.[tj]sx?$/.test(name) && !abs.includes(`${join('src', 'test')}`)) yield abs
  }
}
for (const abs of walk(resolve(root, 'apps/web/src'))) {
  const src = readFileSync(abs, 'utf8')
  for (const [re, label] of forbidden) {
    if (re.test(src)) failures.push(`${relative(root, abs)}: ${label} is incompatible with the strict CSP`)
  }
}

const indexHtml = read('apps/web/index.html')
if (/<style[\s>]/i.test(indexHtml)) failures.push('apps/web/index.html: inline <style> block')
if (/\sstyle\s*=/i.test(indexHtml)) failures.push('apps/web/index.html: inline style attribute')
// Every <script> must be an external src= script with nothing before its next
// closing tag. Scanned by index rather than a tag regex so variants such as
// `</script >` cannot hide an inline body.
const lowerHtml = indexHtml.toLowerCase()
for (let at = lowerHtml.indexOf('<script'); at !== -1; at = lowerHtml.indexOf('<script', at + 1)) {
  const openEnd = lowerHtml.indexOf('>', at)
  const close = lowerHtml.indexOf('</script', openEnd)
  const opening = lowerHtml.slice(at, openEnd + 1)
  const body = openEnd === -1 ? '' : lowerHtml.slice(openEnd + 1, close === -1 ? undefined : close)
  if (!/\ssrc\s*=/.test(opening) || body.trim()) failures.push('apps/web/index.html: inline <script> body')
}

// Browser-level enforcement must stay wired: the spec runs the production build
// under nginx.conf's exact headers.
if (!read('playwright.config.ts').includes('scripts/serve-web-csp.mjs')) failures.push('playwright.config.ts: strict-CSP web server (scripts/serve-web-csp.mjs) is not configured')
if (!read('e2e/csp-strict.spec.ts').includes('securitypolicyviolation')) failures.push('e2e/csp-strict.spec.ts: must assert on securitypolicyviolation events')

if (failures.length) {
  console.error('Strict CSP check FAILED')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('Strict CSP check passed')
console.log(' - nginx CSP has no unsafe-inline and style-src-attr is none')
console.log(' - web source has no raw style-attribute, <style> or innerHTML writes')
console.log(' - index.html has no inline style or script')
console.log(' - browser enforcement spec is wired to the production build')

import fs from 'node:fs'

const nginx = fs.readFileSync('nginx.conf', 'utf8')
const vite = fs.readFileSync('apps/web/vite.config.ts', 'utf8')
const runtime = fs.readFileSync('apps/web/src/cspStyle.ts', 'utf8')

const failures = []
if (/unsafe-inline/.test(nginx)) failures.push('nginx.conf still contains unsafe-inline')
if (!/style-src-attr 'none'/.test(nginx)) failures.push("nginx.conf must enforce style-src-attr 'none'")
if (!/react\/jsx-runtime/.test(vite) || !/csp-jsx-runtime/.test(vite)) failures.push('Vite must alias the React JSX runtime to the CSP runtime')
if (!/react\/jsx-dev-runtime/.test(vite) || !/csp-jsx-dev-runtime/.test(vite)) failures.push('Vite must alias the React JSX dev runtime to the CSP runtime')
if (!/insertRule/.test(runtime) || !/transformStyleProps/.test(runtime)) failures.push('CSP style runtime is incomplete')

if (failures.length) {
  console.error('CSP hardening check FAILED')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('CSP hardening check PASS')

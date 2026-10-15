// Bundles the client-side evidence modules (apps/web/src/lib/evidence) into one script so browser
// tests can run the real code, unmodified, inside real Chromium. Uses Vite's own build API (already
// a dependency of the web app); nothing is written to disk.
import path from 'node:path'
import { build } from 'vite'

// Playwright runs from the repository root (playwright.config.ts lives there).
const root = process.cwd()
let cached: Promise<string> | null = null

export function evidenceBundle(): Promise<string> {
  cached ??= (async () => {
    // Vite's build() forces NODE_ENV=production for the whole process; put it back so the test process is unaffected.
    const previous = process.env.NODE_ENV
    const out = await build({
      root, configFile: false, logLevel: 'silent',
      build: { write: false, minify: false, target: 'es2022', lib: { entry: path.join(root, 'apps/web/src/lib/evidence/browserEntry.ts'), formats: ['iife'], name: 'AcaosEvidence' } },
    })
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous
    const outputs = Array.isArray(out) ? out : [out as { output: Array<{ type: string; code?: string }> }]
    const chunk = outputs.flatMap((o) => ('output' in o ? o.output : [])).find((o) => o.type === 'chunk')
    if (!chunk?.code) throw new Error('evidence bundle produced no code')
    return chunk.code
  })()
  return cached
}

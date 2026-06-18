/**
 * Distributable zip builder — produces self-contained .zip bundles of ACAOS
 * that anyone can download and "load up" without cloning the repo.
 *
 * It writes two artifacts into dist-pack/:
 *
 *   1. acaos-source.zip     — the full project, exactly as committed (a clean
 *                             `git archive` of HEAD, no node_modules / .git /
 *                             local junk). Unzip → `npm install` → run.
 *
 *   2. acaos-pilot-pack.zip — the operator bundle: just what a pilot runner
 *                             needs (run-sheet, DNS setup, signals template,
 *                             the import/results scripts, .env.example) plus a
 *                             generated QUICKSTART. Hand this to a non-developer.
 *
 * Usage:
 *   node scripts/make-zips.mjs            # build both
 *   node scripts/make-zips.mjs pilot      # just the pilot pack
 *   node scripts/make-zips.mjs source     # just the source zip
 *
 * Dependency-free: uses the system `git` and `zip` (both standard on CI/dev
 * boxes). Output is reproducible — re-running overwrites the artifacts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'dist-pack')

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], ...opts })
}

function ensureTool(name) {
  try {
    run(name === 'git' ? 'git' : 'zip', name === 'git' ? ['--version'] : ['-v'], { stdio: 'ignore' })
  } catch {
    console.error(`Required tool "${name}" not found on PATH. Install it and retry.`)
    process.exit(1)
  }
}

function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

function report(file) {
  const { size } = statSync(file)
  console.log(`  ✓ ${file.replace(ROOT + '/', '')}  (${humanSize(size)})`)
}

// ── Source zip: a clean export of exactly what's committed at HEAD. ──────────
function buildSource() {
  ensureTool('git')
  const out = join(OUT_DIR, 'acaos-source.zip')
  if (existsSync(out)) rmSync(out)
  run('git', ['archive', '--format=zip', '--prefix=acaos/', '-o', out, 'HEAD'])
  report(out)
}

// ── Pilot pack: the operator-facing subset + a generated QUICKSTART. ─────────
const PILOT_FILES = [
  'docs/pilot/PILOT_RUNSHEET.md',
  'docs/pilot/DOMAIN_DNS_SETUP.md',
  'docs/pilot/signals-template.csv',
  'scripts/pilot-import.mjs',
  'scripts/pilot-results.mjs',
  '.env.example',
]

const QUICKSTART = `# ACAOS Pilot Pack

Everything you need to run one ACAOS pilot — prove which buying signals drive
replies — without cloning the repository.

## What's in here

- **PILOT_RUNSHEET.md** — the step-by-step run-sheet. Start here.
- **DOMAIN_DNS_SETUP.md** — authenticate your sending domain (SPF/DKIM/DMARC).
  Do this first; deliverability decides whether your reply numbers mean anything.
- **signals-template.csv** — copy this and fill one row per real buying signal.
- **pilot-import.mjs** — feeds your filled-in CSV into ACAOS.
- **pilot-results.mjs** — reads back the reply rate per signal type.
- **.env.example** — reference for the environment values referenced below.

## Prerequisites

- Node.js 20+ installed (\`node --version\`).
- An ACAOS workspace you can log into, and its \`WORKSPACE_ID\`.
- An \`AUTH_TOKEN\` (JWT) for that workspace — see the header of
  \`pilot-import.mjs\` for exactly where to copy it from.
- The API base URL of your ACAOS deployment.

## The 60-second version

1. Read **PILOT_RUNSHEET.md** top to bottom.
2. Authenticate your domain (**DOMAIN_DNS_SETUP.md**).
3. Copy **signals-template.csv**, fill 50–100 real, evidence-backed signals.
4. Feed them in:

   \`\`\`bash
   API_URL=https://<your-api> AUTH_TOKEN=<jwt> WORKSPACE_ID=ws_xxx \\
     node pilot-import.mjs your-signals.csv
   \`\`\`

5. Review + approve the best 10–20 drafts in the dashboard, then send.
6. After a few days, read the results:

   \`\`\`bash
   DATABASE_URL=postgres://... WORKSPACE_ID=ws_xxx node pilot-results.mjs
   \`\`\`

The signal type with the highest reply rate is the one worth automating next.
`

function buildPilot() {
  ensureTool('zip')
  for (const f of PILOT_FILES) {
    if (!existsSync(join(ROOT, f))) {
      console.error(`Pilot file missing: ${f} (repo layout changed?). Aborting.`)
      process.exit(1)
    }
  }
  const out = join(OUT_DIR, 'acaos-pilot-pack.zip')
  if (existsSync(out)) rmSync(out)

  const tmp = mkdtempSync(join(tmpdir(), 'acaos-pilot-'))
  const stage = join(tmp, 'acaos-pilot-pack')
  try {
    mkdirSync(stage, { recursive: true })
    for (const f of PILOT_FILES) {
      const base = f.split('/').pop()
      cpSync(join(ROOT, f), join(stage, base))
    }
    writeFileSync(join(stage, 'QUICKSTART.md'), QUICKSTART)
    // Zip from the temp root so the archive contains a single top-level folder.
    run('zip', ['-r', '-q', out, 'acaos-pilot-pack'], { cwd: tmp })
    report(out)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  const which = (process.argv[2] || 'all').toLowerCase()
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('Building distributable zips → dist-pack/')
  if (which === 'all' || which === 'source') buildSource()
  if (which === 'all' || which === 'pilot') buildPilot()
  if (!['all', 'source', 'pilot'].includes(which)) {
    console.error(`Unknown target "${which}". Use: all | source | pilot.`)
    process.exit(1)
  }
  console.log('Done.')
}

main()

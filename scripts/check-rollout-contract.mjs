#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

const requiredFiles = [
  '.github/workflows/post-deploy-smoke.yml',
  '.github/workflows/release.yml',
  'docs/GITHUB_ADMIN.md',
  'docs/CI_CD.md',
  'docs/DEPLOY_RUNBOOK.md',
  'scripts/smoke-deploy.mjs',
]

const missingFiles = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)))
if (missingFiles.length > 0) {
  console.error('Missing rollout contract file(s):')
  for (const file of missingFiles) console.error(`- ${file}`)
  process.exit(1)
}

const githubAdminText = fs.readFileSync(path.join(root, 'docs/GITHUB_ADMIN.md'), 'utf8')
const ciText = fs.readFileSync(path.join(root, 'docs/CI_CD.md'), 'utf8')
const deployRunbookText = fs.readFileSync(path.join(root, 'docs/DEPLOY_RUNBOOK.md'), 'utf8')
const smokeWorkflowText = fs.readFileSync(path.join(root, '.github/workflows/post-deploy-smoke.yml'), 'utf8')

const requiredAdminTerms = ['required', 'staging', 'production', 'SMOKE_API_URL', 'SMOKE_WORKER_URL']
const missingAdminTerms = requiredAdminTerms.filter((term) => !githubAdminText.includes(term))
if (missingAdminTerms.length > 0) {
  console.error('docs/GITHUB_ADMIN.md is missing rollout terms:')
  for (const term of missingAdminTerms) console.error(`- ${term}`)
  process.exit(1)
}

const requiredCiTerms = ['Post-deploy smoke', 'release-manifest.json', 'expected_version', 'expected_commit']
const missingCiTerms = requiredCiTerms.filter((term) => !ciText.includes(term))
if (missingCiTerms.length > 0) {
  console.error('docs/CI_CD.md is missing rollout terms:')
  for (const term of missingCiTerms) console.error(`- ${term}`)
  process.exit(1)
}

const requiredRunbookTerms = ['smoke:deploy', 'release-manifest.json', 'X-Acaos-Release-Id', 'staging', 'production']
const missingRunbookTerms = requiredRunbookTerms.filter((term) => !deployRunbookText.includes(term))
if (missingRunbookTerms.length > 0) {
  console.error('docs/DEPLOY_RUNBOOK.md is missing rollout terms:')
  for (const term of missingRunbookTerms) console.error(`- ${term}`)
  process.exit(1)
}

const requiredWorkflowTerms = ['workflow_dispatch', 'workflow_call', 'SMOKE_API_URL', 'SMOKE_WORKER_URL', 'METRICS_TOKEN']
const missingWorkflowTerms = requiredWorkflowTerms.filter((term) => !smokeWorkflowText.includes(term))
if (missingWorkflowTerms.length > 0) {
  console.error('post-deploy smoke workflow is missing rollout terms:')
  for (const term of missingWorkflowTerms) console.error(`- ${term}`)
  process.exit(1)
}

console.log('Rollout contract check passed.')

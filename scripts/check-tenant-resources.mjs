#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p) => readFileSync(resolve(p), 'utf8')
const failures = []
const requireText = (file, needle, label = needle) => {
  const src = read(file)
  if (!src.includes(needle)) failures.push(`${file}: missing ${label}`)
}

// Universal resource-router boundaries. These are the id-only entrypoints that
// cannot obtain workspaceId from query/body and therefore must derive it from the
// resource before the handler executes.
requireText('apps/api/src/routes/campaigns.ts', "campaignsRouter.use('/:id', tenantResourceScope({", 'campaign resource tenant scope')
requireText('apps/api/src/routes/missions.ts', "missionsRouter.use('/:id', tenantResourceScope({", 'mission resource tenant scope')
requireText('apps/api/src/routes/leads.ts', "const leadTenantScope = tenantResourceScope({", 'lead resource tenant scope')
{
  const src = read('apps/api/src/routes/leads.ts')
  const routeCount = (src.match(/leadsRouter\.(?:get|post|patch|put|delete)\(\s*'\/:id(?:\/[^']*)?'/g) ?? []).length
  const guardedCount = (src.match(/leadsRouter\.(?:get|post|patch|put|delete)\(\s*'\/:id(?:\/[^']*)?'\s*,\s*leadTenantScope/g) ?? []).length
  if (routeCount !== guardedCount) failures.push(`apps/api/src/routes/leads.ts: ${guardedCount}/${routeCount} /:id lead routes use leadTenantScope`)
}
requireText('apps/api/src/routes/signals.ts', "signalsRouter.use('/:id', tenantResourceScope({", 'signal resource tenant scope')
requireText('apps/api/src/routes/inbox.ts', "inboxRouter.use('/reply/:replyId', tenantResourceScope({", 'inbox reply tenant scope')

const prospectFiles = [
  'apps/api/src/routes/prospects/crud.ts',
  'apps/api/src/routes/prospects/scoring.ts',
  'apps/api/src/routes/prospects/intents.ts',
  'apps/api/src/routes/prospects/enrichment.ts',
]
for (const file of prospectFiles) {
  const src = read(file)
  const routeCount = (src.match(/prospectsRouter\.(?:get|post|patch|put|delete)\('\/:id(?:\/[^']*)?'/g) ?? []).length
  const guardedCount = (src.match(/prospectsRouter\.(?:get|post|patch|put|delete)\('\/:id(?:\/[^']*)?'\s*,\s*prospectTenantScope/g) ?? []).length
  if (routeCount !== guardedCount) failures.push(`${file}: ${guardedCount}/${routeCount} /:id prospect routes use prospectTenantScope`)
}

// Drift detector for id-only Prisma lookups. Counts are deliberately pinned so a
// newly added unique-id lookup cannot silently expand the reviewed surface. Global
// User/Workspace lookups are excluded; every tenant-model lookup must live in a
// reviewed file and be protected either by a resource boundary or an explicit
// parent/workspace authorization check documented in the matrix.
const reviewedTenantLookupCounts = new Map([
  ['apps/api/src/routes/campaigns.ts', 8],
  ['apps/api/src/routes/leads.ts', 8],
  ['apps/api/src/routes/missions.ts', 5],
  ['apps/api/src/routes/signals.ts', 2],
  ['apps/api/src/routes/inbox.ts', 3],
  ['apps/api/src/routes/jobs.ts', 3],
  ['apps/api/src/routes/prospects/helpers.ts', 2],
  ['apps/api/src/routes/prospects/scoring.ts', 1],
  ['apps/api/src/routes/prospects/crud.ts', 4],
  ['apps/api/src/routes/prospects/enrichment.ts', 1],
  ['apps/api/src/routes/prospects/discovery.ts', 1],
  ['apps/api/src/routes/prospects/intents.ts', 8],
])
const tenantModels = new Set([
  'campaign','lead','mission','prospect','signal','outreachSent','outreachDraft','outreachIntent',
  'recommendation','commercialOpportunity','quote','job','opsJobSite','opsShiftRecord','opsCrewMember',
  'opsRosterEntry','opsAlert','opportunity','followupTask','inboxReplySend','outreachSelection',
])
for (const [file, expected] of reviewedTenantLookupCounts) {
  const src = read(file)
  const re = /prisma\.([A-Za-z0-9_]+)\.findUnique\s*\(\s*\{\s*where\s*:\s*\{\s*id\s*:/gs
  let count = 0
  for (const m of src.matchAll(re)) if (tenantModels.has(m[1])) count++
  if (count !== expected) failures.push(`${file}: tenant id-only lookup count changed: expected ${expected}, found ${count}; review and update tenant-resource matrix`)
}

if (failures.length) {
  console.error('Tenant resource boundary check FAILED')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('Tenant resource boundary check passed')
console.log(' - primary id-only routers are resource-scoped')
console.log(' - prospect id routes are individually resource-scoped')
console.log(' - reviewed tenant id-only lookup inventory has not drifted')

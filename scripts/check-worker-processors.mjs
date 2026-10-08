import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const barrel = path.join(root, 'apps/worker/src/processors.ts')
const dir = path.join(root, 'apps/worker/src/processors')
const required = ['scoring.ts','outreach.ts','campaignSend.ts','followups.ts','discovery.ts','replies.ts']

const failures = []
const barrelText = fs.readFileSync(barrel, 'utf8')
if (barrelText.split(/\r?\n/).length > 40) failures.push('processors.ts must remain a thin compatibility barrel')
for (const file of required) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) { failures.push(`missing processor domain module: ${file}`); continue }
  const text = fs.readFileSync(full, 'utf8')
  const lines = text.split(/\r?\n/).length
  if (lines > 1100) failures.push(`${file} has ${lines} lines; split before it becomes another catch-all`)
  if (/\bnew\s+Worker\s*\(/.test(text)) failures.push(`${file} constructs BullMQ Worker; domain processors must stay directly testable without Redis construction`)
}
for (const stem of ['scoring','outreach','campaignSend','followups','discovery','replies']) {
  if (!barrelText.includes(`./processors/${stem}.js`)) failures.push(`barrel missing ${stem} export`)
}
if (failures.length) {
  console.error('Worker processor boundary check FAILED')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log('Worker processor boundary check PASS')

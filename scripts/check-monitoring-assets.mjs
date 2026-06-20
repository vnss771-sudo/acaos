import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

const requiredFiles = [
  'docs/OPERATIONS.md',
  'docs/SLO.md',
  'docs/RUNBOOKS.md',
  'ops/monitoring/README.md',
  'ops/monitoring/prometheus.yml',
  'ops/monitoring/alerts.yml',
  'ops/monitoring/alertmanager.yml',
  'ops/monitoring/blackbox.yml',
  'ops/monitoring/grafana-dashboard.json',
]

const missingFiles = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)))
if (missingFiles.length > 0) {
  console.error('Missing observability asset(s):')
  for (const file of missingFiles) console.error(`- ${file}`)
  process.exit(1)
}

const alertsText = fs.readFileSync(path.join(root, 'ops/monitoring/alerts.yml'), 'utf8')
const sloText = fs.readFileSync(path.join(root, 'docs/SLO.md'), 'utf8')
const runbooksText = fs.readFileSync(path.join(root, 'docs/RUNBOOKS.md'), 'utf8')
const operationsText = fs.readFileSync(path.join(root, 'docs/OPERATIONS.md'), 'utf8')
const monitoringReadmeText = fs.readFileSync(path.join(root, 'ops/monitoring/README.md'), 'utf8')

const alertNames = [...alertsText.matchAll(/^\s*-\s*alert:\s*([A-Za-z0-9_:-]+)\s*$/gm)].map((match) => match[1])
if (alertNames.length === 0) {
  console.error('No alert rules were found in ops/monitoring/alerts.yml.')
  process.exit(1)
}

const uncoveredAlerts = alertNames.filter((name) => !runbooksText.includes(name))
if (uncoveredAlerts.length > 0) {
  console.error('Runbooks are missing alert references for:')
  for (const name of uncoveredAlerts) console.error(`- ${name}`)
  process.exit(1)
}

const requiredDocLinks = [
  '[`ops/monitoring/alerts.yml`](../ops/monitoring/alerts.yml)',
  '[`RUNBOOKS.md`](RUNBOOKS.md)',
  '[`SLO.md`](SLO.md)',
  '[`../../docs/SLO.md`](../../docs/SLO.md)',
  '[`../../docs/RUNBOOKS.md`](../../docs/RUNBOOKS.md)',
]
const missingDocLinks = requiredDocLinks.filter((needle) =>
  !sloText.includes(needle) &&
  !runbooksText.includes(needle) &&
  !monitoringReadmeText.includes(needle),
)
if (missingDocLinks.length > 0) {
  console.error('Expected cross-links are missing from observability docs:')
  for (const needle of missingDocLinks) console.error(`- ${needle}`)
  process.exit(1)
}

if (!operationsText.includes('/metrics') || !operationsText.includes('/api/ready')) {
  console.error('docs/OPERATIONS.md must document /metrics and /api/ready.')
  process.exit(1)
}

const dashboardPath = path.join(root, 'ops/monitoring/grafana-dashboard.json')
const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'))
if (typeof dashboard.title !== 'string' || dashboard.title.trim() === '') {
  console.error('Grafana dashboard title is missing.')
  process.exit(1)
}
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 6) {
  console.error('Grafana dashboard should contain at least 6 panels.')
  process.exit(1)
}

const panelTitles = dashboard.panels.map((panel) => panel?.title).filter((title) => typeof title === 'string')
const requiredPanelTitles = ['API request rate by status', 'API latency p99 by route', 'API 5xx ratio', 'BullMQ queue depth (waiting)', 'Worker job rate by result']
const missingPanels = requiredPanelTitles.filter((title) => !panelTitles.includes(title))
if (missingPanels.length > 0) {
  console.error('Grafana dashboard is missing expected panels:')
  for (const title of missingPanels) console.error(`- ${title}`)
  process.exit(1)
}

console.log(`Observability asset check passed for ${alertNames.length} alert rules and ${dashboard.panels.length} dashboard panels.`)

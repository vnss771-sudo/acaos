/**
 * Pilot signal importer — feeds a CSV of real signals into ACAOS via the
 * evidence-gated POST /api/prospects/import-signals endpoint. Each row becomes a
 * prospect + an evidence-backed signal; scoring + recommendations + intents
 * cascade automatically server-side.
 *
 * Usage:
 *   API_URL=https://<your-api>.up.railway.app \
 *   AUTH_TOKEN=<your JWT access token> \
 *   WORKSPACE_ID=ws_xxx \
 *   node scripts/pilot-import.mjs docs/pilot/signals-template.csv
 *
 * Get AUTH_TOKEN from your browser: log in, open DevTools → Application →
 * Local Storage → copy the access token. WORKSPACE_ID is in the dashboard URL /
 * network calls.
 *
 * Evidence is mandatory: every row MUST have provider + sourceType, else the
 * server rejects that row (this is the moat discipline — no unsourced signals).
 */
import { readFileSync } from 'node:fs'

// Minimal CSV parser: handles quoted fields with commas + escaped "" quotes.
function parseCsv(text) {
  const rows = []
  let field = '', row = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQuotes = false
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* skip */ }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

async function main() {
  const apiUrl = process.env.API_URL?.replace(/\/$/, '')
  const token = process.env.AUTH_TOKEN
  const workspaceId = process.env.WORKSPACE_ID
  const path = process.argv[2]

  if (!apiUrl || !token || !workspaceId || !path) {
    console.error('Required: API_URL, AUTH_TOKEN, WORKSPACE_ID env + CSV path arg.')
    console.error('Example: node scripts/pilot-import.mjs docs/pilot/signals-template.csv')
    process.exit(1)
  }

  const lines = parseCsv(readFileSync(path, 'utf8'))
  if (lines.length < 2) { console.error('CSV has no data rows.'); process.exit(1) }
  const header = lines[0].map((h) => h.trim())
  const rows = lines.slice(1).map((cells) => {
    const obj = {}
    header.forEach((h, idx) => {
      const v = (cells[idx] ?? '').trim()
      if (v !== '') obj[h] = v
    })
    return obj
  })

  if (rows.length > 500) { console.error('Max 500 rows per import. Split the file.'); process.exit(1) }
  console.log(`Importing ${rows.length} rows → ${apiUrl}/api/prospects/import-signals`)

  const res = await fetch(`${apiUrl}/api/prospects/import-signals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId, rows }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { console.error(`HTTP ${res.status}:`, JSON.stringify(data, null, 2)); process.exit(1) }

  console.log('\n✓ Import complete')
  console.log(`  Prospects created: ${data.prospectsCreated}`)
  console.log(`  Prospects reused:  ${data.prospectsReused}`)
  console.log(`  Signals ingested:  ${data.signalsIngested}`)
  console.log(`  Rows failed:       ${data.failed}`)
  if (data.errors?.length) {
    console.log('\n  First errors:')
    for (const e of data.errors) console.log(`    - ${e}`)
  }
  console.log('\nScoring is now running server-side. Watch the dashboard\'s')
  console.log('"This week\'s outreach" card for evidence-backed intents to review.')
}

main().catch((e) => { console.error(e); process.exit(1) })

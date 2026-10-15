// Operator tool: restore ONE evidence file from the independent backup.
//
//   npm run evidence:restore -- --workspace <id> --job <id> --file <id>                 (dry-run)
//   npm run evidence:restore -- --workspace <id> --job <id> --file <id> --execute \
//        --approved-by <owner user id> --reason "ticket/short reason"
//
// Dry-run is the default and changes nothing. Executing requires an owner of the
// workspace as approver. See docs/runbooks/EVIDENCE_RESTORE_DRILL.md. Run it with the
// restore operator's own short-lived credentials (primary write, backup read), never
// the API's or the backup worker's.
import { restoreEvidenceFile, RestoreRefusedError } from '../apps/worker/src/processors/evidenceRestore.ts'
import { prisma } from '../packages/backend-core/src/lib/prisma.ts'

function parse(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[k] = true
    else { out[k] = next; i++ }
  }
  return out
}

async function main() {
  const a = parse(process.argv.slice(2))
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  const workspaceId = str('workspace'); const jobId = str('job'); const fileId = str('file')
  if (!workspaceId || !jobId || !fileId) throw new Error('--workspace, --job and --file are all required')
  const execute = a.execute === true
  if (a['dry-run'] === true && execute) throw new Error('--dry-run and --execute are mutually exclusive')
  const report = await restoreEvidenceFile({
    workspaceId, jobId, fileId, execute, approvedByUserId: str('approved-by'), reason: str('reason'),
  })
  console.log(JSON.stringify({ ...report, workspaceId, jobId, fileId }, null, 2))
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof RestoreRefusedError ? e.message : `restore failed: ${(e as Error).message}`)
    await prisma.$disconnect().catch(() => {})
    process.exit(e instanceof RestoreRefusedError ? 2 : 1)
  })

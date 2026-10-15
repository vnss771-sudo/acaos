// Operator tool and scheduled job for controlled evidence deletion (C4). This is the
// ONLY process that holds delete-capable evidence credentials. Run it as its own
// service/job, never inside the API or the normal worker.
//
//   npm run evidence:deletion -- run                      one cycle: ledger trust gate, hold sync,
//                                                          reconcile, execute due approved requests
//   npm run evidence:deletion -- reconcile [--workspace]  trust gate + reconcile only
//   npm run evidence:deletion -- probe-ledger             measure what the ledger credential can do
//   npm run evidence:deletion -- verify-ledger --workspace <id>   check the ledger hash chain
//
// Everything is disabled unless EVIDENCE_DESTRUCTIVE_ENABLED=true and the full
// configuration is valid (see packages/backend-core/src/lib/evidenceDeletionConfig.ts).
// `run` and `reconcile` additionally refuse unless the ledger is provably unable to
// overwrite or delete (probe level "enforced").
import { runDeletionCycle, reconcileEvidenceLedger, buildDeletionStores } from '../apps/worker/src/processors/evidenceDeletion.ts'
import { resolveEvidenceDeletion, resolveEvidenceLedger } from '../packages/backend-core/src/lib/evidenceDeletionConfig.ts'
import { EvidenceLedger, assertLedgerTrusted, probeLedgerImmutability } from '../packages/backend-core/src/lib/evidenceLedger.ts'
import { createS3EvidenceStore } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { prisma } from '../packages/backend-core/src/lib/prisma.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const cmd = process.argv[2]
  if (cmd === 'probe-ledger' || cmd === 'verify-ledger') {
    const l = resolveEvidenceLedger()
    if (!l.enabled) { console.error(JSON.stringify({ skipped: l.reason, problems: l.problems })); process.exit(2) }
    const store = createS3EvidenceStore(l.config)
    if (cmd === 'probe-ledger') { console.log(JSON.stringify(await probeLedgerImmutability(store), null, 2)); return }
    const ws = arg('workspace'); if (!ws) throw new Error('--workspace is required')
    const r = await new EvidenceLedger(store, l.config.macKey).verifyChain(ws)
    console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1)
  }
  if (cmd === 'run') { const r = await runDeletionCycle(); console.log(JSON.stringify(r, null, 2)); if ('skipped' in r) process.exit(2); return }
  if (cmd === 'reconcile') {
    const s = resolveEvidenceDeletion()
    if (!s.enabled) { console.error(JSON.stringify({ skipped: s.reason, problems: s.problems })); process.exit(2) }
    const stores = buildDeletionStores(s.config)
    await assertLedgerTrusted(stores.ledgerStore, { allowUnenforced: s.config.allowUnenforcedLedger })
    console.log(JSON.stringify(await reconcileEvidenceLedger({ stores, workspaceId: arg('workspace') }), null, 2)); return
  }
  console.error('usage: evidence-deletion.ts run | reconcile [--workspace id] | probe-ledger | verify-ledger --workspace id'); process.exit(64)
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(`evidence-deletion failed: ${(e as Error).message}`)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})

// Child process for tests-db/evidence-s3-integration.test.ts. Runs one worker
// operation against the real (disposable) S3 stores and SIGKILLs ITSELF right after
// a chosen object write, to simulate a worker dying mid-job (no cleanup, no finally).
//   crash-child.ts backup   <workspaceId> <fileId>   -> dies after the backup object is written
//   crash-child.ts finalize <workspaceId> <fileId>   -> dies after the final object is published
//   crash-child.ts delete   <requestId> <nowMs>      -> dies right after the PRIMARY object is deleted
//                                                       (needs the EVIDENCE_DELETE_* / ledger / seal env)
import { replicateEvidenceFile } from '../../apps/worker/src/processors/evidenceBackup.ts'
import { finalizeEvidenceFile } from '../../apps/worker/src/processors/evidenceFinalize.ts'
import { executeDeletionRequest, buildDeletionStores } from '../../apps/worker/src/processors/evidenceDeletion.ts'
import { getEvidenceStore, getEvidenceBackupStore, type EvidenceObjectStore } from '../../packages/backend-core/src/lib/evidenceStorage.ts'
import { resolveEvidenceStorage } from '../../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { resolveEvidenceBackup } from '../../packages/backend-core/src/lib/evidenceBackupConfig.ts'
import { resolveEvidenceDeletion } from '../../packages/backend-core/src/lib/evidenceDeletionConfig.ts'

const [mode, a, b] = process.argv.slice(2)

function dieAfterPut(store: EvidenceObjectStore, match: string): EvidenceObjectStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'putBytes') {
        return async (key: string, body: Buffer, ct: string) => {
          await target.putBytes(key, body, ct)
          if (key.includes(match)) process.kill(process.pid, 'SIGKILL')
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

async function main() {
  if (mode === 'delete') {
    const state = resolveEvidenceDeletion()
    if (!state.enabled) { console.error(`deletion not configured: ${state.problems.join('; ')}`); process.exit(3) }
    const stores = buildDeletionStores(state.config)
    const realDelete = stores.primary.delete.bind(stores.primary)
    stores.primary.delete = async (key: string) => { await realDelete(key); process.kill(process.pid, 'SIGKILL') }
    await executeDeletionRequest({ requestId: a, stores, sealKey: state.config.sealKey, now: new Date(Number(b)) })
  } else {
    const ps = resolveEvidenceStorage(); const bs = resolveEvidenceBackup()
    if (!ps.enabled || !bs.enabled) { console.error('storage not configured'); process.exit(3) }
    if (mode === 'backup') {
      await replicateEvidenceFile({ workspaceId: a, fileId: b, primary: getEvidenceStore(ps.config), backup: dieAfterPut(getEvidenceBackupStore(bs.config), '/final/') })
    } else if (mode === 'finalize') {
      await finalizeEvidenceFile({ workspaceId: a, fileId: b, store: dieAfterPut(getEvidenceStore(ps.config), '/final/'), config: ps.config })
    }
  }
  console.error('child finished without being killed')
  process.exit(4)
}
void main()

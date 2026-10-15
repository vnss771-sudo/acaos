// Child process for tests-db/evidence-s3-integration.test.ts. Runs one worker
// operation against the real (disposable) S3 stores and SIGKILLs ITSELF right after
// a chosen object write, to simulate a worker dying mid-job (no cleanup, no finally).
//   crash-child.ts backup   <workspaceId> <fileId>   -> dies after the backup object is written
//   crash-child.ts finalize <workspaceId> <fileId>   -> dies after the final object is published
import { replicateEvidenceFile } from '../../apps/worker/src/processors/evidenceBackup.ts'
import { finalizeEvidenceFile } from '../../apps/worker/src/processors/evidenceFinalize.ts'
import { getEvidenceStore, getEvidenceBackupStore, type EvidenceObjectStore } from '../../packages/backend-core/src/lib/evidenceStorage.ts'
import { resolveEvidenceStorage } from '../../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { resolveEvidenceBackup } from '../../packages/backend-core/src/lib/evidenceBackupConfig.ts'

const [mode, workspaceId, fileId] = process.argv.slice(2)
const ps = resolveEvidenceStorage(); const bs = resolveEvidenceBackup()
if (!ps.enabled || !bs.enabled) { console.error('storage not configured'); process.exit(3) }
const psc = ps.config, bsc = bs.config

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
  if (mode === 'backup') {
    await replicateEvidenceFile({ workspaceId, fileId, primary: getEvidenceStore(psc), backup: dieAfterPut(getEvidenceBackupStore(bsc), '/final/') })
  } else if (mode === 'finalize') {
    await finalizeEvidenceFile({ workspaceId, fileId, store: dieAfterPut(getEvidenceStore(psc), '/final/'), config: psc })
  }
  console.error('child finished without being killed')
  process.exit(4)
}
void main()

// The API's handle on the external deletion ledger (append/read only). Kept apart from
// the governance router so code that only needs the ledger (workspace erasure) does not
// load every route. Returns null when the ledger is not configured (fail closed).
import { resolveEvidenceLedger } from '@acaos/backend-core/lib/evidenceDeletionConfig.js'
import { createS3EvidenceStore } from '@acaos/backend-core/lib/evidenceStorage.js'
import { EvidenceLedger } from '@acaos/backend-core/lib/evidenceLedger.js'

let ledgerOverride: EvidenceLedger | null | undefined
/** Tests inject a ledger here (null = "unavailable"; undefined = use the environment). Refused in production. */
export function setApiLedgerForTests(l: EvidenceLedger | null | undefined): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setApiLedgerForTests is not available in production')
  ledgerOverride = l
}

let ledgerCache: { id: string; ledger: EvidenceLedger } | null = null
export function getApiLedger(): EvidenceLedger | null {
  if (ledgerOverride !== undefined) return ledgerOverride
  const s = resolveEvidenceLedger()
  if (!s.enabled) return null
  const id = `${s.config.endpoint}|${s.config.bucket}|${s.config.accessKeyId}`
  if (!ledgerCache || ledgerCache.id !== id) ledgerCache = { id, ledger: new EvidenceLedger(createS3EvidenceStore(s.config), s.config.macKey) }
  return ledgerCache.ledger
}

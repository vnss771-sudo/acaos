// Re-export shim — the implementation lives in @acaos/backend-core so the worker
// and the shared enrich core can use it without depending on apps/api.
export * from '@acaos/backend-core/lib/signalIngest.js'

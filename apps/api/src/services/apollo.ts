// Re-export shim — the implementation lives in @acaos/backend-core so the worker
// can share it without depending on apps/api. Import sites stay unchanged.
export * from '@acaos/backend-core/services/apollo.js'

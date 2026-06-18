// Re-export shim: the implementation lives in @acaos/backend-core so the worker
// can share it without importing apps/api. Kept here so existing api imports of
// `../lib/prisma.js` keep resolving.
export * from '@acaos/backend-core/lib/prisma.js'

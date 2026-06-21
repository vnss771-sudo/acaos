// The prospects router was decomposed into cohesive modules under ./prospects/.
// This file is kept as the stable import path (./routes/prospects.js) and simply
// re-exports the assembled router and its public surface unchanged.
export { prospectsRouter, normalizeDomain } from './prospects/index.js'

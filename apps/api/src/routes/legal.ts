import { Router } from 'express'
import { asyncHandler } from '../lib/http.js'
import { generalRateLimit } from '../middleware/rateLimit.js'
import { subprocessorDisclosure, dpaDisclosure, COMPLIANCE_TERMS_VERSION } from '@acaos/backend-core/lib/subprocessors.js'

// Public, unauthenticated transparency endpoints (GDPR Art. 13–14). Prospects and
// auditors can review who processes data — and the current terms version — without
// an account. Static, code-derived data; rate-limited like any public surface.
export const legalRouter = Router()
legalRouter.use(generalRateLimit)

legalRouter.get('/subprocessors', asyncHandler(async (_req, res) => {
  res.json(subprocessorDisclosure())
}))

legalRouter.get('/terms', asyncHandler(async (_req, res) => {
  res.json({ termsVersion: COMPLIANCE_TERMS_VERSION })
}))

// Data Processing Agreement summary (Art. 28). Public like the other legal
// disclosures — a prospect can review the DPA before ever creating a workspace.
legalRouter.get('/dpa', asyncHandler(async (_req, res) => {
  res.json(dpaDisclosure())
}))

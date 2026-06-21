import type { Request, Response, NextFunction } from 'express'
import { isFeatureEnabled, FEATURE_LABEL, type Feature } from '@acaos/backend-core/lib/launchControls.js'

// Reject a request at the edge when its feature is killed via a launch control
// (FEATURE_AI/SEND/MAILBOX_SYNC/DISCOVERY = false). 503 + a stable code so the
// client can show "temporarily unavailable" rather than treat it as a hard error.
// The worker honours the SAME switch, so disabling a feature stops both new API
// work and scheduled/in-flight worker execution.
export function requireFeature(feature: Feature) {
  return function (_req: Request, res: Response, next: NextFunction) {
    if (!isFeatureEnabled(feature)) {
      return res.status(503).json({
        error: `${FEATURE_LABEL[feature]} are temporarily unavailable.`,
        code: 'FEATURE_DISABLED',
      })
    }
    return next()
  }
}

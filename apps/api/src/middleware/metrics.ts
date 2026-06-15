import type { Request, Response, NextFunction } from 'express'
import { performance } from 'node:perf_hooks'
import { incRequest, observeDuration, incInFlight, decInFlight } from '../lib/metrics.js'

// Records request count + latency + in-flight gauge per request. Labels use the
// matched route *pattern* (e.g. /api/leads/:id), not the concrete URL, so metric
// cardinality stays bounded regardless of ids/query strings.
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now()
  incInFlight()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    decInFlight()
    // req.route is set once Express matches a handler; baseUrl is the mount path.
    const pattern = req.route?.path ?? ''
    const route = (req.baseUrl || '') + (pattern || (req.route ? '' : '/<unmatched>'))
    const durationSec = (performance.now() - start) / 1000
    incRequest(req.method, route, res.statusCode)
    observeDuration(req.method, route, durationSec)
  }
  // 'finish' = response fully sent; 'close' covers aborted connections.
  res.on('finish', finish)
  res.on('close', finish)
  next()
}

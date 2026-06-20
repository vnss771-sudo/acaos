import { logger } from './logger.js'
import { getRuntimeMetadata } from './release.js'

export type LifecycleEventType = 'startup' | 'shutdown' | 'crash' | 'deploy'

export function logLifecycleEvent(
  service: string,
  event: LifecycleEventType,
  fields: Record<string, unknown> = {},
): void {
  const metadata = getRuntimeMetadata(service)
  const record = {
    kind: event === 'deploy' ? 'deploy' : 'lifecycle',
    event,
    service: metadata.service,
    releaseId: metadata.releaseId,
    version: metadata.version,
    commit: metadata.commit,
    buildTime: metadata.buildTime,
    environment: metadata.environment,
    ...fields,
  }

  if (event === 'crash') logger.error(`${service} ${event}`, record)
  else logger.info(`${service} ${event}`, record)
}

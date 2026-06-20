const PROCESS_STARTED_AT = new Date()

export type RuntimeMetadata = {
  service: string
  version: string
  commit: string | null
  buildTime: string | null
  releaseId: string
  environment: string
  runtime: string
  pid: number
  startedAt: string
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function getRuntimeMetadata(service: string): RuntimeMetadata {
  const version = readEnv('ACAOS_RELEASE_VERSION')
    ?? readEnv('npm_package_version')
    ?? process.env.npm_package_version
    ?? '0.0.0-dev'
  const commit = readEnv('ACAOS_RELEASE_SHA') ?? readEnv('GITHUB_SHA') ?? null
  const buildTime = readEnv('ACAOS_BUILD_TIME') ?? null
  const releaseId = readEnv('ACAOS_RELEASE_ID')
    ?? (commit ? `${version}+${commit.slice(0, 12)}` : version)

  return {
    service,
    version,
    commit,
    buildTime,
    releaseId,
    environment: process.env.NODE_ENV || 'development',
    runtime: process.version,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT.toISOString(),
  }
}

export function getProcessStartTimeSeconds(): number {
  return Math.floor(PROCESS_STARTED_AT.getTime() / 1000)
}

export function getBuildInfoLabels(service: string): Record<string, string> {
  const metadata = getRuntimeMetadata(service)
  return {
    service: metadata.service,
    version: metadata.version,
    commit: metadata.commit ?? 'unknown',
    release_id: metadata.releaseId,
    environment: metadata.environment,
    build_time: metadata.buildTime ?? 'unknown',
  }
}

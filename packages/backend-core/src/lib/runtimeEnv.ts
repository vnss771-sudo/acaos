// True when a hosting platform marker is present, so an unset NODE_ENV on a
// deployed box can't silently take the insecure dev-key/secret fallbacks.
const PLATFORM_MARKERS = ['RAILWAY_ENVIRONMENT', 'VERCEL', 'K_SERVICE', 'FLY_APP_NAME', 'RENDER', 'DYNO']

export function isDeployedPlatform(): boolean {
  return PLATFORM_MARKERS.some((k) => !!process.env[k])
}

/** Only an unset NODE_ENV (off-platform) or explicit development/test may use insecure fallbacks. */
export function allowsInsecureFallback(): boolean {
  const env = (process.env.NODE_ENV || '').trim()
  if (env === '') return !isDeployedPlatform()
  return env === 'development' || env === 'test'
}

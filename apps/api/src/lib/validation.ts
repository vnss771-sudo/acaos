const slugUnsafeChars = /[^a-z0-9-]+/g
const repeatedDash = /-{2,}/g

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

export function isValidEmail(value: string) {
  // Reject control characters (including null bytes) before pattern matching.
  // The control-char range in this regex is the whole point, so the lint rule
  // that flags control chars in regexes is intentionally disabled here.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value))
}

export function validatePassword(value: string) {
  if (value.length < 8) return 'Password must be at least 8 characters'
  return ''
}

export function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized : undefined
}

export function buildWorkspaceName(name: string | undefined, email: string) {
  const normalizedName = normalizeOptionalString(name)
  if (normalizedName) return `${normalizedName}'s Workspace`
  return `${email.split('@')[0]}'s Workspace`
}

export function sanitizeWorkspaceSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(slugUnsafeChars, '-')
    .replace(repeatedDash, '-')
    .replace(/^-|-$/g, '')
}

export function buildWorkspaceSlugSeed(name: string | undefined, email: string) {
  const normalizedName = normalizeOptionalString(name)
  const seed = normalizedName || email.split('@')[0] || 'workspace'
  const sanitized = sanitizeWorkspaceSlug(seed)
  return sanitized || 'workspace'
}

export function appendSlugSuffix(base: string, suffix: string | number) {
  return sanitizeWorkspaceSlug(`${base}-${suffix}`) || `workspace-${suffix}`
}

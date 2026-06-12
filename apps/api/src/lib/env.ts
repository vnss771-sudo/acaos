// Startup environment validation — validates required vars and exports typed accessors.
// Call validateEnv() once at boot (before any other initialisation).

const REQUIRED_VARS = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'] as const

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(k => !process.env[k]?.trim())
  if (missing.length === 0) return
  throw new Error(
    `[boot] Missing required environment variables:\n` +
    missing.map(v => `  • ${v}`).join('\n') +
    `\n\nCheck your .env file or deployment environment config.`
  )
}

// Returns true only when all listed vars are non-empty.
export function hasEnv(keys: string[]): boolean {
  return keys.every(k => Boolean(process.env[k]?.trim()))
}

// Throws with a clear message when any listed var is absent.
// Use this to gate optional integrations (OpenAI, SMTP, etc.) at the call site.
export function requireEnv(keys: string[]): void {
  const missing = keys.filter(k => !process.env[k]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}

// ── Typed config accessors ───────────────────────────────────────────────────
// Access validated env vars through these helpers rather than process.env directly.

export const cfg = {
  get nodeEnv()  { return (process.env.NODE_ENV ?? 'development') as 'development' | 'production' | 'test' },
  get port()     { return Number(process.env.PORT ?? 4000) },

  // Core — always present after validateEnv()
  get databaseUrl() { return process.env.DATABASE_URL! },
  get redisUrl()    { return process.env.REDIS_URL! },
  get jwtSecret()   { return process.env.JWT_SECRET! },

  // AI
  get openaiApiKey() { return process.env.OPENAI_API_KEY ?? null },
  get openaiModel()  { return process.env.OPENAI_MODEL ?? 'gpt-4o-mini' },

  // URLs
  get appUrl() { return process.env.APP_URL ?? null },
  get webUrl() { return process.env.WEB_URL ?? null },

  // SMTP — all optional; use hasEnv(['SMTP_HOST', ...]) to check before using
  get smtpHost() { return process.env.SMTP_HOST ?? null },
  get smtpPort() { return process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null },
  get smtpFrom() { return process.env.SMTP_FROM ?? null },
  get smtpUser() { return process.env.SMTP_USER ?? null },
  get smtpPass() { return process.env.SMTP_PASS ?? null },

  // IMAP
  get imapHost() { return process.env.IMAP_HOST ?? null },
  get imapUser() { return process.env.IMAP_USER ?? null },
  get imapPass() { return process.env.IMAP_PASS ?? null },

  // Integrations
  get serperApiKey() { return process.env.SERPER_API_KEY ?? null },
  get apolloApiKey() { return process.env.APOLLO_API_KEY ?? null },

  // Stripe
  get stripeSecretKey()      { return process.env.STRIPE_SECRET_KEY      ?? null },
  get stripeWebhookSecret()  { return process.env.STRIPE_WEBHOOK_SECRET  ?? null },
  get stripePriceStarter()   { return process.env.STRIPE_PRICE_STARTER   ?? null },
  get stripePriceGrowth()    { return process.env.STRIPE_PRICE_GROWTH    ?? null },

  // JWT timing (optional overrides)
  get jwtExpiresIn()       { return process.env.JWT_EXPIRES_IN        ?? '15m' },
  get refreshTokenDays()   { return Number(process.env.REFRESH_TOKEN_DAYS ?? 30) },

  // SMTP extras
  get smtpSecure() {
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587
    return process.env.SMTP_SECURE === 'true' || port === 465
  },

  // IMAP extras
  get imapPort()   { return Number(process.env.IMAP_PORT   ?? 993) },
  get imapSecure() { return String(process.env.IMAP_SECURE ?? 'true') === 'true' },

  // Bull Board dashboard
  get bullBoardUser() { return process.env.BULL_BOARD_USER ?? null },
  get bullBoardPass() { return process.env.BULL_BOARD_PASS ?? null },

  // API URL (for tracking pixel injection)
  get apiUrl() { return process.env.API_URL ?? null },

  // Tracking — HMAC secret for signed click-redirect URLs (falls back to jwtSecret)
  get trackingSecret() { return process.env.TRACKING_SECRET ?? process.env.JWT_SECRET! },
} as const

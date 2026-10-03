// "Sign in with Google / Microsoft" for the workspace mailbox. The mailbox
// still syncs over IMAP and sends over SMTP, so the reply cursor, bounce and
// complaint handling, reply attribution and enquiry triage are unchanged; only
// the authentication changes, from a stored password to an OAuth2 access token
// (SASL XOAUTH2, supported by both imapflow and nodemailer).
//
// Why: Gmail only allows passwords through app passwords, which need 2-Step
// Verification and an extra step most contractors won't find. Microsoft has
// turned off password ("basic") authentication for Exchange Online. Signing in
// is the only way many mailboxes can be connected at all.
//
// Tokens: the refresh token is stored encrypted (lib/encrypt.ts) on
// WorkspaceEmailConfig. Access tokens are short-lived (about an hour), so they
// are cached in memory only and refreshed on demand; nothing extra is stored.
// A refresh token the provider rejects (revoked, password changed, expired)
// marks the config with oauthError so Settings can ask the user to reconnect.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from './errors.js'
import { prisma } from './prisma.js'
import { decryptSecret, encryptSecret, isEncrypted } from './encrypt.js'
import { fetchWithTimeout } from './fetchWithTimeout.js'
import { getJwtSecret } from './jwt.js'

export const MAIL_OAUTH_PROVIDERS = ['google', 'microsoft'] as const
export type MailOAuthProvider = (typeof MAIL_OAUTH_PROVIDERS)[number]

export const AUTH_METHOD_PASSWORD = 'PASSWORD'
export const AUTH_METHOD: Record<MailOAuthProvider, string> = {
  google: 'GOOGLE_OAUTH',
  microsoft: 'MICROSOFT_OAUTH',
}

export type MailServers = {
  smtpHost: string; smtpPort: number; smtpSecure: boolean
  imapHost: string; imapPort: number; imapSecure: boolean
}

type ProviderSpec = {
  label: string
  clientIdEnv: string
  clientSecretEnv: string
  authUrl: () => string
  tokenUrl: () => string
  scopes: string[]
  extraAuthParams: Record<string, string>
  servers: MailServers
}

function microsoftTenant(): string {
  const t = (process.env.MICROSOFT_OAUTH_TENANT || 'common').trim()
  return /^[A-Za-z0-9.-]{1,100}$/.test(t) ? t : 'common'
}

const PROVIDERS: Record<MailOAuthProvider, ProviderSpec> = {
  google: {
    label: 'Google',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    // https://mail.google.com/ is the only Google scope that grants IMAP/SMTP.
    scopes: ['openid', 'email', 'https://mail.google.com/'],
    // offline + consent: always return a refresh token, even on a reconnect.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    servers: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true },
  },
  microsoft: {
    label: 'Microsoft',
    clientIdEnv: 'MICROSOFT_OAUTH_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_OAUTH_CLIENT_SECRET',
    authUrl: () => `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`,
    scopes: [
      'openid', 'email', 'offline_access',
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ],
    extraAuthParams: { prompt: 'select_account' },
    // Port 587 STARTTLS is the only SMTP endpoint Microsoft supports for OAuth.
    servers: { smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true },
  },
}

export function isMailOAuthProvider(v: unknown): v is MailOAuthProvider {
  return typeof v === 'string' && (MAIL_OAUTH_PROVIDERS as readonly string[]).includes(v)
}

export function mailOAuthProviderLabel(p: MailOAuthProvider): string {
  return PROVIDERS[p].label
}

export function mailOAuthServers(p: MailOAuthProvider): MailServers {
  return { ...PROVIDERS[p].servers }
}

function clientCredentials(p: MailOAuthProvider): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[PROVIDERS[p].clientIdEnv]?.trim()
  const clientSecret = process.env[PROVIDERS[p].clientSecretEnv]?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Providers this deployment can offer: client credentials set and API_URL known. */
export function configuredMailOAuthProviders(): MailOAuthProvider[] {
  if (!process.env.API_URL?.trim()) return []
  return MAIL_OAUTH_PROVIDERS.filter(p => clientCredentials(p) !== null)
}

/** The one redirect URI to register with both providers. */
export function mailOAuthRedirectUri(): string {
  const base = process.env.API_URL?.trim().replace(/\/+$/, '')
  if (!base) throw new ApiError(503, 'API_URL is not configured')
  return `${base}/api/mailbox/oauth/callback`
}

// ── state ────────────────────────────────────────────────────────────────────
// The callback is a browser redirect from the provider, so it carries no bearer
// token. The state binds the flow to the user and workspace that started it,
// signed with HMAC (key separated from session JWTs) and valid for 10 minutes.
// The callback still re-checks that this user may manage the workspace's email.

export type MailOAuthState = { userId: string; workspaceId: string; provider: MailOAuthProvider }
const STATE_TTL_MS = 10 * 60_000

// A dedicated signing key derived from the JWT secret with HKDF (RFC 5869), so
// a state signature can never double as a session token or vice versa.
function stateKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', getJwtSecret(), Buffer.alloc(0), 'acaos:mail-oauth-state:v1', 32))
}

export function signMailOAuthState(s: MailOAuthState, now: number = Date.now()): string {
  const body = Buffer.from(JSON.stringify({
    u: s.userId, w: s.workspaceId, p: s.provider, n: randomBytes(12).toString('base64url'), exp: now + STATE_TTL_MS,
  })).toString('base64url')
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyMailOAuthState(state: string, now: number = Date.now()): MailOAuthState {
  const [body, sig, extra] = String(state ?? '').split('.')
  if (!body || !sig || extra !== undefined) throw new ApiError(400, 'Invalid sign-in state')
  const expected = createHmac('sha256', stateKey()).update(body).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError(400, 'Invalid sign-in state')
  let parsed: { u?: unknown; w?: unknown; p?: unknown; exp?: unknown }
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'Invalid sign-in state') }
  if (typeof parsed.exp !== 'number' || parsed.exp < now) throw new ApiError(400, 'Sign-in took too long — please try again')
  if (typeof parsed.u !== 'string' || typeof parsed.w !== 'string' || !isMailOAuthProvider(parsed.p)) throw new ApiError(400, 'Invalid sign-in state')
  return { userId: parsed.u, workspaceId: parsed.w, provider: parsed.p }
}

// ── authorization + tokens ───────────────────────────────────────────────────

export function buildMailOAuthUrl(p: MailOAuthProvider, state: string, loginHint?: string): string {
  const creds = clientCredentials(p)
  if (!creds) throw new ApiError(503, `${PROVIDERS[p].label} sign-in is not configured`)
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: mailOAuthRedirectUri(),
    response_type: 'code',
    scope: PROVIDERS[p].scopes.join(' '),
    state,
    ...PROVIDERS[p].extraAuthParams,
    ...(loginHint ? { login_hint: loginHint } : {}),
  })
  return `${PROVIDERS[p].authUrl()}?${params}`
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
const defaultFetch: FetchLike = (url, init) => fetchWithTimeout(url, init, 15_000)

/** The provider refused the grant: the user must sign in again. */
export class MailOAuthGrantError extends Error {}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string }

async function tokenRequest(p: MailOAuthProvider, form: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  const creds = clientCredentials(p)
  if (!creds) throw new ApiError(503, `${PROVIDERS[p].label} sign-in is not configured`)
  const res = await fetchImpl(PROVIDERS[p].tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...form }).toString(),
  })
  let json: TokenResponse = {}
  try { json = (await res.json()) as TokenResponse } catch { /* non-JSON error body */ }
  if (!res.ok || !json.access_token) {
    // invalid_grant = revoked/expired/consumed; nothing but a new sign-in fixes it.
    if (json.error === 'invalid_grant') throw new MailOAuthGrantError(json.error_description || 'invalid_grant')
    throw new Error(`${PROVIDERS[p].label} token request failed (${res.status}${json.error ? ` ${json.error}` : ''})`)
  }
  return json
}

// The id_token arrives directly from the provider's token endpoint over TLS, so
// its claims can be read without verifying the signature (OIDC Core §3.1.3.7).
function accountEmailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const email = [claims.email, claims.preferred_username, claims.upn].find(v => typeof v === 'string' && v.includes('@'))
    return typeof email === 'string' ? email.trim().toLowerCase() : null
  } catch {
    return null
  }
}

export type MailOAuthGrant = { accountEmail: string; refreshToken: string; accessToken: string; expiresAt: number }

export async function exchangeMailOAuthCode(p: MailOAuthProvider, code: string, fetchImpl: FetchLike = defaultFetch, now: number = Date.now()): Promise<MailOAuthGrant> {
  const json = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: mailOAuthRedirectUri() }, fetchImpl)
  if (!json.refresh_token) throw new ApiError(502, `${PROVIDERS[p].label} did not grant offline access — please try again`)
  const accountEmail = accountEmailFromIdToken(json.id_token)
  if (!accountEmail) throw new ApiError(502, `${PROVIDERS[p].label} did not return the mailbox address`)
  return { accountEmail, refreshToken: json.refresh_token, accessToken: json.access_token!, expiresAt: now + (json.expires_in ?? 3600) * 1000 }
}

// ── access tokens for IMAP/SMTP ──────────────────────────────────────────────

export type OAuthMailConfig = {
  workspaceId?: string | null
  authMethod?: string | null
  oauthRefreshToken?: string | null
}

export function providerForAuthMethod(authMethod: string | null | undefined): MailOAuthProvider | null {
  return MAIL_OAUTH_PROVIDERS.find(p => AUTH_METHOD[p] === authMethod) ?? null
}

/** True when the config authenticates by OAuth and has a refresh token to use. */
export function isOAuthMailConfig(cfg: OAuthMailConfig | null | undefined): boolean {
  return Boolean(cfg && providerForAuthMethod(cfg.authMethod) && cfg.oauthRefreshToken)
}

type CachedToken = { accessToken: string; expiresAt: number; refreshBlob: string }
const tokenCache = new Map<string, CachedToken>()

/** Seed the cache with the token from a fresh sign-in (saves one refresh). */
export function primeMailAccessToken(workspaceId: string, refreshBlob: string, accessToken: string, expiresAt: number): void {
  tokenCache.set(workspaceId, { accessToken, expiresAt, refreshBlob })
}

/** Test seam. */
export function clearMailAccessTokenCache(): void {
  tokenCache.clear()
}

export type AccessTokenDeps = {
  fetch?: FetchLike
  /** Persist provider-side changes (rotated refresh token / needs-reconnect). */
  persist?: (workspaceId: string, data: { oauthRefreshToken?: string; oauthError?: string | null }) => Promise<void>
  now?: () => number
}

const defaultPersist: NonNullable<AccessTokenDeps['persist']> = async (workspaceId, data) => {
  await prisma.workspaceEmailConfig.update({ where: { workspaceId }, data })
}

const REFRESH_MARGIN_MS = 2 * 60_000
export const RECONNECT_MESSAGE = 'Mailbox sign-in has expired or was revoked — reconnect it in Settings'

/**
 * A valid access token for an OAuth mailbox config, refreshing when the cached
 * one is missing or within two minutes of expiry. A rejected refresh token
 * records oauthError (shown in Settings) and throws a 409 the caller surfaces.
 */
export async function getMailAccessToken(cfg: OAuthMailConfig, deps: AccessTokenDeps = {}): Promise<string> {
  const provider = providerForAuthMethod(cfg.authMethod)
  const workspaceId = cfg.workspaceId
  if (!provider || !cfg.oauthRefreshToken || !workspaceId) throw new ApiError(409, 'Mailbox is not connected by sign-in')
  const now = (deps.now ?? Date.now)()
  const cached = tokenCache.get(workspaceId)
  if (cached && cached.refreshBlob === cfg.oauthRefreshToken && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.accessToken

  const refreshToken = isEncrypted(cfg.oauthRefreshToken) ? decryptSecret(cfg.oauthRefreshToken) : cfg.oauthRefreshToken
  const persist = deps.persist ?? defaultPersist
  let json: TokenResponse
  try {
    json = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken }, deps.fetch ?? defaultFetch)
  } catch (err) {
    if (err instanceof MailOAuthGrantError) {
      tokenCache.delete(workspaceId)
      await persist(workspaceId, { oauthError: RECONNECT_MESSAGE }).catch(() => {})
      throw new ApiError(409, RECONNECT_MESSAGE)
    }
    throw err
  }

  // Microsoft rotates refresh tokens; keep the newest so the grant never lapses.
  let refreshBlob = cfg.oauthRefreshToken
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    refreshBlob = encryptSecret(json.refresh_token)
    await persist(workspaceId, { oauthRefreshToken: refreshBlob, oauthError: null })
  }
  tokenCache.set(workspaceId, { accessToken: json.access_token!, expiresAt: now + (json.expires_in ?? 3600) * 1000, refreshBlob })
  return json.access_token!
}

/** Best-effort revocation on disconnect (Google only; Microsoft has no revoke endpoint). */
export async function revokeMailOAuth(cfg: OAuthMailConfig, fetchImpl: FetchLike = defaultFetch): Promise<void> {
  if (cfg.workspaceId) tokenCache.delete(cfg.workspaceId)
  if (providerForAuthMethod(cfg.authMethod) !== 'google' || !cfg.oauthRefreshToken) return
  const token = isEncrypted(cfg.oauthRefreshToken) ? decryptSecret(cfg.oauthRefreshToken) : cfg.oauthRefreshToken
  try {
    await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })
  } catch { /* the stored token is deleted either way */ }
}

# Mailbox sign-in (Google / Microsoft)

Workspaces can connect their sending/receiving mailbox by signing in instead of
typing SMTP/IMAP passwords. The mailbox still syncs over IMAP and sends over
SMTP; only the authentication changes (OAuth2 / SASL XOAUTH2). Code:
`packages/backend-core/src/lib/mailOAuth.ts`, `apps/api/src/routes/mailboxOAuth.ts`.

A provider's button appears in **Settings → Email Configuration** only when its
client credentials and `API_URL` are set.

## Redirect URI

Register exactly this with both providers:

```
${API_URL}/api/mailbox/oauth/callback
```

After the callback the browser returns to `${APP_URL}/settings?mailbox=…`.

## Google

1. Google Cloud console → APIs & Services → Credentials → *OAuth client ID* (Web application). Add the redirect URI.
2. OAuth consent screen scopes: `openid`, `email`, `https://mail.google.com/`.
3. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

`https://mail.google.com/` is a **restricted** scope. Until the app passes
Google's verification (including the CASA security assessment), only test users
listed on the consent screen can connect, and their grants expire after 7 days.
Plan verification before launch.

## Microsoft

1. Microsoft Entra admin center → App registrations → New registration. Supported account types: *any organizational directory and personal Microsoft accounts* (or your own tenant only). Add the redirect URI as a *Web* platform.
2. Certificates & secrets → new client secret.
3. API permissions (delegated): `offline_access`, `openid`, `email`, and from *Office 365 Exchange Online*: `IMAP.AccessAsUser.All`, `SMTP.Send`.
4. Set `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, and optionally `MICROSOFT_OAUTH_TENANT` (default `common`).

Sending uses SMTP AUTH on `smtp.office365.com:587`. Tenants with security
defaults (and many others) have SMTP AUTH turned off, and the send then fails
with `5.7.139`. The tenant admin must enable *Authenticated SMTP* for that
mailbox (Microsoft 365 admin center → user → Mail → Manage email apps).
Receiving over IMAP is unaffected.

## Tokens and failure modes

- The refresh token is stored encrypted (`EMAIL_ENCRYPTION_KEY(S)`) and is included in key rotation. Access tokens are cached in memory only.
- If the provider rejects the refresh token (revoked, password changed, expired), the config gets `oauthError`; Settings shows it with a **Reconnect** button. Sync and sends for that workspace fail with a 409 until then.
- Saving server settings by hand replaces a sign-in connection. **Disconnect** revokes the grant at Google (Microsoft has no revoke endpoint) and clears the mailbox.
- Connecting a different mailbox resets the IMAP reply cursor.

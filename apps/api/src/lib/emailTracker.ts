// Injects open-tracking pixel and HMAC-signed click-tracking wrappers into email HTML.
// Returns the original HTML unmodified when APP_URL is not configured (dev-safe).

import { cfg } from './env.js'
import { signTrackingUrl } from './trackingUrl.js'

function baseUrl(): string | null {
  return cfg.appUrl?.replace(/\/$/, '') || cfg.apiUrl?.replace(/\/$/, '') || null
}

export function injectTracking(html: string, messageOutcomeId: string): string {
  const base = baseUrl()
  if (!base) return html

  // Tracking pixel — append before </body> or at end
  const pixelUrl  = `${base}/api/track/open/${encodeURIComponent(messageOutcomeId)}`
  const pixelHtml = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  // Wrap anchor hrefs with HMAC-signed click tracking (skip mailto: and anchor links)
  const withClicks = html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (_match, url) => `href="${signTrackingUrl(base, messageOutcomeId, url)}"`
  )

  // Inject pixel before </body> if present, otherwise append
  if (/<\/body>/i.test(withClicks)) {
    return withClicks.replace(/<\/body>/i, `${pixelHtml}</body>`)
  }
  return withClicks + pixelHtml
}

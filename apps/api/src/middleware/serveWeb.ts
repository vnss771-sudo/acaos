import express from 'express'
import type { Express } from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the directory holding the built SPA. Defaults to the web workspace's
 * Vite output relative to the compiled API (apps/api/dist/middleware ->
 * apps/web/dist). In the Docker image the build is copied next to the API, so
 * WEB_DIST_DIR is set explicitly there.
 */
export function resolveWebDistDir(explicit?: string): string {
  const fromEnv = explicit ?? process.env.WEB_DIST_DIR
  if (fromEnv?.trim()) return path.resolve(fromEnv.trim())
  return path.resolve(here, '../../../web/dist')
}

/**
 * Serve the built web SPA from the SAME ORIGIN as the API.
 *
 * Co-locating the frontend with the API is the supported production topology:
 * the HttpOnly refresh-token cookie is first-party `SameSite=Lax` (see
 * lib/cookies.ts), so the web app and API must share a site. Serving both from
 * one origin is the simplest way to guarantee that and avoids CORS entirely.
 *
 * Returns true if a build was found and mounted, false otherwise (API-only).
 * Must be mounted AFTER the `/api/*` routers and BEFORE the 404 handler so
 * unknown API paths still produce JSON 404s rather than the SPA shell.
 */
export function mountWebApp(app: Express, explicitDir?: string): boolean {
  const distDir = resolveWebDistDir(explicitDir)
  const indexHtml = path.join(distDir, 'index.html')

  if (!existsSync(indexHtml)) {
    console.warn(`[web] No SPA build at ${distDir} — serving API only`)
    return false
  }

  // Static assets. Vite fingerprints files under /assets, so they can be cached
  // forever; index.html must never be cached so new deploys are picked up.
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(`${path.sep}index.html`)) {
          res.setHeader('Cache-Control', 'no-cache')
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    })
  )

  // SPA fallback: any non-API GET/HEAD navigation returns the app shell so
  // client-side routing (deep links, refresh) works. API paths are excluded so
  // they fall through to the JSON 404 handler.
  app.get(/^\/(?!api\/).*/, (_req, res, next) => {
    // The shell must never be cached so deploys are picked up immediately.
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(indexHtml, (err) => {
      if (err) next(err)
    })
  })

  console.log(`[web] Serving SPA from ${distDir}`)
  return true
}

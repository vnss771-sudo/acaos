import type { RouteKey, RouteParams, RouteBody, RouteResponse } from '@acaos/shared'

// Typed route client (A+ review finding P0-3). Wraps the low-level `api(path,
// init)` hook so every mutation is made through a single, contract-keyed call:
//   route('POST /api/campaigns/:id/send', { params: { id }, body: { approved: true } })
// The method, path template, params, and body shape all come from the shared
// RouteContracts map, so a call can't drift from what the backend expects — and
// the response is typed without a manual `api<T>` annotation at every call site.
//
// It intentionally produces the exact same (path, init) the raw `api` call did,
// so it's a drop-in for existing usage and existing tests that assert on `api`.

type RawApi = <T = unknown>(path: string, init?: Record<string, unknown>) => Promise<T>

// Options are derived from the contract: params/body are required only when the
// contract declares them, and forbidden otherwise.
type HasParams<K extends RouteKey> = RouteParams<K> extends undefined ? { params?: undefined } : { params: RouteParams<K> }
type HasBody<K extends RouteKey> = RouteBody<K> extends undefined ? { body?: undefined } : { body: RouteBody<K> }
export type RouteOptions<K extends RouteKey> = HasParams<K> & HasBody<K>

export function makeRouteApi(api: RawApi) {
  return function route<K extends RouteKey>(key: K, opts: RouteOptions<K>): Promise<RouteResponse<K>> {
    const sep = key.indexOf(' ')
    const method = key.slice(0, sep)
    let path = key.slice(sep + 1)

    const params = (opts as { params?: Record<string, string | number> }).params
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        path = path.replace(`:${k}`, encodeURIComponent(String(v)))
      }
    }

    const body = (opts as { body?: unknown }).body
    const init: { method: string; body?: string } = { method }
    if (body !== undefined) init.body = JSON.stringify(body)

    return api<RouteResponse<K>>(path, init)
  }
}

export type RouteApi = ReturnType<typeof makeRouteApi>

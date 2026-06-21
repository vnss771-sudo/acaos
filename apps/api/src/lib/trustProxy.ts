// Parse the TRUST_PROXY env var into an Express `trust proxy` setting.
//
// `trust proxy` controls how Express derives req.ip / req.protocol from the
// X-Forwarded-* chain. Rate limiting keys on req.ip, so a too-broad value lets a
// client spoof X-Forwarded-For and dodge per-IP limits. Keep it as tight as the
// deployment allows:
//   - unset            -> 1   (trust exactly one managed proxy hop; Railway/Render)
//   - "false"/"0"      -> false (trust none; direct exposure)
//   - "true"           -> true  (trust all — only behind a fully trusted network)
//   - a non-negative int -> that many hops
//   - anything else    -> passed through verbatim (e.g. a CIDR list or "loopback",
//                         which Express accepts as a comma-separated subnet spec)
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim()
  if (v === '') return 1
  if (v === 'true') return true
  if (v === 'false') return false
  const n = Number(v)
  if (Number.isInteger(n) && n >= 0) return n
  return v
}

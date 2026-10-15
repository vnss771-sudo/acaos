// The browser half of the upload: one XMLHttpRequest PUT of the processed JPEG straight to the
// storage host. XHR rather than fetch because only XHR reports upload progress. Verified against
// real Chromium in docs/plans/C5_0_BROWSER_UPLOAD_FINDINGS.md:
//   * Content-Length is a forbidden header for scripts; the browser sends the real body length,
//     which is the length the URL was signed for. We never try to set it.
//   * Content-Type must equal the signed type exactly, so it is set explicitly and the Blob has the
//     same type.
//   * The signed URL and headers are bearer-like secrets: they are used here and never logged,
//     stored or put in an error message.

export type PutOutcome = { status: number; timedOut: boolean; networkError: boolean; aborted: boolean }

export type PutFn = (args: {
  url: string
  contentType: string
  body: Blob
  signal: AbortSignal
  timeoutMs: number
  onProgress: (loaded: number, total: number) => void
}) => Promise<PutOutcome>

export const xhrPut: PutFn = ({ url, contentType, body, signal, timeoutMs, onProgress }) => new Promise((resolve) => {
  const x = new XMLHttpRequest()
  let settled = false
  const done = (o: Partial<PutOutcome> & { status: number }) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', onAbort)
    resolve({ timedOut: false, networkError: false, aborted: false, ...o })
  }
  const onAbort = () => { try { x.abort() } catch { /* already done */ } done({ status: 0, aborted: true }) }
  if (signal.aborted) { done({ status: 0, aborted: true }); return }
  signal.addEventListener('abort', onAbort, { once: true })
  x.open('PUT', url)
  x.timeout = timeoutMs
  x.setRequestHeader('Content-Type', contentType)
  x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
  x.onload = () => done({ status: x.status })
  x.onerror = () => done({ status: 0, networkError: true })
  x.ontimeout = () => done({ status: 0, timedOut: true })
  x.onabort = () => done({ status: 0, aborted: true })
  x.send(body)
})

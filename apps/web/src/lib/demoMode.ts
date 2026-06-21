// Investor / demo mode flag. A self-contained showcase that renders the real
// app shell against seeded data and never calls the backend — for pitches,
// screenshots, and walkthroughs. Entry: `?demo=investor` (or a persisted flag);
// exit clears both.

const DEMO_KEY = 'acaos_investor_demo'

export function isInvestorDemoRequested(search = window.location.search): boolean {
  try {
    const params = new URLSearchParams(search)
    if (params.get('demo') === 'investor') return true
    return localStorage.getItem(DEMO_KEY) === '1'
  } catch {
    return false
  }
}

export function enableInvestorDemo() {
  try { localStorage.setItem(DEMO_KEY, '1') } catch { /* ignore */ }
}

export function clearInvestorDemo() {
  try { localStorage.removeItem(DEMO_KEY) } catch { /* ignore */ }
}

export function removeDemoUrlFlag() {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('demo')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch { /* ignore */ }
}

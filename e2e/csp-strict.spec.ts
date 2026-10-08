import { test, expect, type Page } from '@playwright/test'
import { signUp, uniqueEmail, closeDb } from './helpers.js'

// Strict CSP in a real browser: this spec runs against the production web build
// served with the exact server-level headers from nginx.conf (see
// scripts/serve-web-csp.mjs), not the Vite dev server, so Chromium enforces
// style-src-attr 'none' / no 'unsafe-inline' exactly as production does.
test.use({ baseURL: 'http://localhost:4173' })
test.afterAll(closeDb)

type Violation = { directive: string; blockedURI: string; sample: string }

// Every hub and tab in apps/web/src/lib/hubs.ts (Admin is owner-gated and skipped).
const HUBS: Array<[hub: string, tabs: string[]]> = [
  ['Today', ['Today', 'Overview']],
  ['Work', ['Find work', 'Clients', 'Jobs & margins', 'Scorecard']],
  ['Crew', ['Overview', 'Crew', 'Shifts', 'Roster', 'Sites', 'Fatigue', 'Alerts']],
  ['Outreach', ['Campaigns', 'To review', 'Inbox', 'Leads', 'Missions', 'Analytics', 'AI tools']],
  ['Settings', ['Settings', 'Billing']],
]

async function recordViolations(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: Violation[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push({ directive: e.violatedDirective, blockedURI: e.blockedURI, sample: e.sample })
    })
  })
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp)

test('production build renders every hub under the strict nginx CSP with zero violations', async ({ page }) => {
  await recordViolations(page)

  const response = await page.goto('/')
  const csp = response?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("style-src-attr 'none'")
  expect(csp).not.toContain('unsafe-inline')

  // Negative control: a raw style attribute must be refused and reported, proving
  // the policy is actually enforced on this origin (not merely present).
  const applied = await page.evaluate(() => {
    const probe = document.createElement('div')
    document.body.appendChild(probe)
    probe.setAttribute('style', 'outline-width: 7px')
    const width = getComputedStyle(probe).outlineWidth
    probe.remove()
    return width
  })
  expect(applied).not.toBe('7px')
  await expect.poll(async () => (await violations(page)).some((v) => v.directive.startsWith('style-src-attr'))).toBe(true)
  await page.evaluate(() => { (window as unknown as { __csp: Violation[] }).__csp = [] })

  await signUp(page, uniqueEmail())
  await page.getByRole('button', { name: /Set up email outreach/ }).click()
  await page.getByRole('button', { name: /Select Industrial Services/ }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByRole('button', { name: /Looks good/ }).click()
  await page.getByRole('button', { name: /Skip for now/ }).click()
  await page.getByRole('button', { name: /Explore first/ }).click()

  for (const [hub, tabs] of HUBS) {
    await page.getByRole('button', { name: new RegExp(`^${hub}$`) }).click()
    for (const tab of tabs) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await page.waitForLoadState('networkidle')
    }
  }

  // React style={{}} props are applied through the CSSOM, which CSP permits: they
  // must be present on the DOM and actually win in the computed style.
  const inline = await page.evaluate(() => {
    const styled = Array.from(document.querySelectorAll<HTMLElement>('[style]'))
    // CSS blockification legitimately rewrites `display` for flex/grid items and
    // floated or absolutely positioned boxes, so compare only elsewhere.
    const display = styled.filter((el) => {
      if (!el.style.display || el.style.display === 'none') return false
      const own = getComputedStyle(el)
      const parent = el.parentElement ? getComputedStyle(el.parentElement).display : ''
      return !/flex|grid/.test(parent) && own.float === 'none' && !/absolute|fixed/.test(own.position)
    })
    return {
      styled: styled.length,
      displayChecked: display.length,
      displayMismatches: display.filter((el) => getComputedStyle(el).display !== el.style.display).length,
    }
  })
  expect(inline.styled).toBeGreaterThan(0)
  expect(inline.displayChecked).toBeGreaterThan(0)
  expect(inline.displayMismatches).toBe(0)

  expect(await violations(page)).toEqual([])
})

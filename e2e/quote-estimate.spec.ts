import { test, expect } from '@playwright/test'
import { uniqueEmail, signUp, skipOnboarding, verifyEmailInDb, apiLogin, getWorkspaceId, seedDeliveryOpportunity, seedCrewMember, closeDb } from './helpers'

// The quote estimate builder (#419) driven through the real UI and API: build an
// estimate, check the margin figures, take the suggested price, save, reload and
// confirm what was stored. Run at desktop and phone widths.
//
// Inputs: 400 h at $55/h (crew median of $50 and $60) + 20 % on-costs = $26,400 labour;
// materials $15,000 + subcontractors $5,000 → direct cost $46,400; overheads 10 % = $4,640.
// At $60,000: gross margin $13,600 (22.7 %), after overheads $8,960 (14.9 %).
// 25 % target: $46,400 / 0.75 = $61,866.67, rounded up to cents.

test.afterAll(async () => { await closeDb() })

// Desktop saves with the Save beside the amount; the phone (touch, mobile emulation)
// saves with the Save below the estimate, tapped while an input has focus.
for (const vp of [{ name: 'desktop', width: 1280, height: 800, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]) {
  test(`quote estimate builder: estimate, use the suggested price, save and reload (${vp.name})`, async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.mobile, isMobile: vp.mobile })
    const page = await context.newPage()
    const email = uniqueEmail()
    await signUp(page, email)
    await skipOnboarding(page)
    await verifyEmailInDb(email)
    const token = await apiLogin(request, email)
    const workspaceId = await getWorkspaceId(request, token)
    const headers = { Authorization: `Bearer ${token}` }
    const opportunityId = await seedDeliveryOpportunity(workspaceId)
    await seedCrewMember(workspaceId, 50)
    await seedCrewMember(workspaceId, 60)
    const pursued = await request.patch(`/api/opportunities/${opportunityId}/status`, { headers, data: { workspaceId, status: 'PURSUING' } })
    expect(pursued.ok(), await pursued.text()).toBeTruthy()
    // A quote saved without an estimate (as every quote before #419 was) must display as before.
    const plainOpportunityId = await seedDeliveryOpportunity(workspaceId)
    const plain = await request.post('/api/delivery/quotes', { headers, data: { workspaceId, opportunityId: plainOpportunityId, amountCents: 1_234_500, submit: true } })
    expect(plain.status(), await plain.text()).toBe(201)

    // Quoting defaults through Settings: 20 % on-costs, 10 % overheads, 25 % target.
    await page.goto('/settings')
    await expect(page.getByLabel('Labour on-costs (%)')).toHaveValue('')   // NULL until set
    await page.getByLabel('Labour on-costs (%)').fill('20')
    await page.getByLabel('Overheads (% of direct cost)').fill('10')
    await page.getByLabel('Target gross margin (%)').fill('25')
    await page.getByRole('button', { name: 'Save quoting defaults' }).click()
    await expect(page.getByText('Quoting defaults saved')).toBeVisible()
    const settingsOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(settingsOverflow, 'horizontal overflow on Settings, in px').toBeLessThanOrEqual(0)

    await page.goto('/ops/find-work')
    await expect(page.getByText('Quoted $12,345')).toBeVisible()
    await page.getByRole('button', { name: 'Record quote' }).click()
    await page.getByRole('button', { name: 'Build estimate' }).click()

    await page.getByLabel('Estimated labour hours').fill('400')
    await page.getByRole('button', { name: 'Use it' }).click()          // crew median rate
    await expect(page.getByLabel('Labour rate ($/h)')).toHaveValue('55')
    // Copied in from the workspace defaults when the builder opened, not typed.
    await expect(page.getByLabel('On-costs (%)')).toHaveValue('20')
    await expect(page.getByLabel('Overheads (% of direct)')).toHaveValue('10')
    await expect(page.getByLabel('Target gross margin (%)')).toHaveValue('25')
    await expect(page.getByTestId('estimate-defaults-note')).toBeVisible()
    await page.getByLabel('Materials ($)').fill('15,000')
    await page.getByLabel('Subcontractors ($)').fill('5000')
    await page.getByLabel('Quote amount ($)').fill('60,000')

    const estimate = page.getByRole('region', { name: 'Estimate' })
    await expect(estimate).toContainText('Labour $26,400')
    await expect(estimate).toContainText('Direct cost $46,400')
    await expect(estimate).toContainText('Break-even incl. overheads $51,040')
    await expect(estimate).toContainText('At $60,000: gross margin $13,600 (22.7%)')
    await expect(estimate).toContainText('after overheads $8,960 (14.9%)')
    await expect(estimate).toContainText('For a 25% gross margin, quote at least $61,867')

    // Usable on a phone: nothing forces the page wider than the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/quote-estimate-${vp.name}.png`, fullPage: true })

    // Advisory: the button fills the field; nothing is saved until Save quote.
    await page.getByRole('button', { name: 'Use this price' }).click()
    await expect(page.getByLabel('Quote amount ($)')).toHaveValue('61866.67')
    const before = await request.get(`/api/delivery/quotes?workspaceId=${workspaceId}&opportunityId=${opportunityId}`, { headers })
    expect((await before.json()).quotes).toHaveLength(0)
    await expect(estimate).toContainText('gross margin $15,467 (25%)')

    if (vp.mobile) {
      // Keyboard up: focus a field, then tap the Save below the estimate.
      await page.getByLabel('Target gross margin (%)').focus()
      await page.getByTestId('save-quote-bottom').tap()
    } else {
      await page.getByRole('button', { name: 'Save quote' }).first().click()
    }
    await expect(page.getByText('Quote recorded')).toBeVisible()

    // Reopen: reload the page; the saved estimate is shown as saved, read-only.
    await page.reload()
    await expect(page.getByText(/Quoted \$61,867 · 400 h estimated/)).toBeVisible()
    const summary = page.getByRole('region', { name: 'Saved estimate' })
    await expect(summary).toHaveCount(1)   // the plain quote has none
    await expect(summary).toContainText('labour $26,400 · materials $15,000 · subcontractors $5,000 · overheads $4,640')
    await expect(summary).toContainText('At the quoted $61,867: gross profit $15,467 (25% gross margin) · after overheads $10,827 (17.5%)')
    await expect(summary.locator('input')).toHaveCount(0)
    await expect(page.getByText(/Quoted \$12,345$/)).toBeVisible()

    // Changing the defaults afterwards never alters the saved estimate.
    const changed = await request.put(`/api/workspaces/${workspaceId}/quoting-defaults`, { headers, data: { defaultOnCostPct: 35, defaultOverheadPct: 18, defaultTargetMarginPct: 30 } })
    expect(changed.ok(), await changed.text()).toBeTruthy()
    await page.reload()
    await expect(page.getByRole('region', { name: 'Saved estimate' })).toContainText('labour $26,400 · materials $15,000 · subcontractors $5,000 · overheads $4,640')
    const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflowAfter, 'horizontal overflow after save, in px').toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/quote-estimate-saved-${vp.name}.png`, fullPage: true })
    const saved = await request.get(`/api/delivery/quotes?workspaceId=${workspaceId}&opportunityId=${opportunityId}`, { headers })
    const [quote] = (await saved.json()).quotes
    expect(quote.amountCents).toBe(6_186_667)
    expect(quote.estimatedHours).toBe(400)
    expect(quote.estimate.inputs).toEqual({ labourHours: 400, labourRate: 55, onCostPct: 20, materialsCents: 1_500_000, subcontractCents: 500_000, overheadPct: 10, targetMarginPct: 25 })
    expect(quote.estimate.result.directCostCents).toBe(4_640_000)
    expect(quote.estimate.result.grossMarginCents).toBe(1_546_667)
    expect(quote.estimate.result.marginAfterOverheadsCents).toBe(1_082_667)
    expect(quote.estimate.result.gaps).toEqual([])
    expect((await saved.json()).quotes).toHaveLength(1)   // one save, however it was tapped
    await context.close()
  })
}

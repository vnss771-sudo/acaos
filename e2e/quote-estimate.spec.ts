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

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`quote estimate builder: estimate, use the suggested price, save and reload (${vp.name})`, async ({ page, request }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
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

    await page.goto('/ops/find-work')
    await expect(page.getByText('E2E Warehouse Electrical Package')).toBeVisible()
    await page.getByRole('button', { name: 'Record quote' }).click()
    await page.getByRole('button', { name: 'Build estimate' }).click()

    await page.getByLabel('Estimated labour hours').fill('400')
    await page.getByRole('button', { name: 'Use it' }).click()          // crew median rate
    await expect(page.getByLabel('Labour rate ($/h)')).toHaveValue('55')
    await page.getByLabel('On-costs (%)').fill('20')
    await page.getByLabel('Materials ($)').fill('15,000')
    await page.getByLabel('Subcontractors ($)').fill('5000')
    await page.getByLabel('Overheads (% of direct)').fill('10')
    await page.getByLabel('Target gross margin (%)').fill('25')
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

    await page.getByRole('button', { name: 'Save quote' }).click()
    await expect(page.getByText('Quote recorded')).toBeVisible()

    // Reopen: reload the page and read the stored quote back.
    await page.reload()
    await expect(page.getByText(/Quoted \$61,867 · 400 h estimated/)).toBeVisible()
    const saved = await request.get(`/api/delivery/quotes?workspaceId=${workspaceId}&opportunityId=${opportunityId}`, { headers })
    const [quote] = (await saved.json()).quotes
    expect(quote.amountCents).toBe(6_186_667)
    expect(quote.estimatedHours).toBe(400)
    expect(quote.estimate.inputs).toEqual({ labourHours: 400, labourRate: 55, onCostPct: 20, materialsCents: 1_500_000, subcontractCents: 500_000, overheadPct: 10, targetMarginPct: 25 })
    expect(quote.estimate.result.directCostCents).toBe(4_640_000)
    expect(quote.estimate.result.grossMarginCents).toBe(1_546_667)
    expect(quote.estimate.result.marginAfterOverheadsCents).toBe(1_082_667)
    expect(quote.estimate.result.gaps).toEqual([])
  })
}

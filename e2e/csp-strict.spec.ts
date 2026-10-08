import { test, expect } from '@playwright/test'

test('frontend renders without inline style attributes under the strict CSP contract', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#root')).toBeVisible()
  await expect(page.locator('[style]')).toHaveCount(0)
})

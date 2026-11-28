import { expect, test } from '@playwright/test'

test('open provider pages from consecutive albums and keep the Browse filter', async ({
  page,
  context,
}) => {
  const filters = [{ field: 'provider', value: 'discogs' }]
  await context.route('https://www.discogs.com/**', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'Fixture provider page' }),
  )
  for (const view of ['grid', 'list', 'table']) {
    const params = new URLSearchParams({
      view,
      filters: JSON.stringify(filters),
    })
    await page.goto(`/albums?${params}`)
    const links = page.locator('.ds-play a[aria-label^="Open on Discogs:"]')
    for (const index of [0, 1]) {
      const link = links.nth(index)
      // Hover the containing result before testing the actual hit target.
      await link.locator('xpath=ancestor::*[@data-item-index][1]').hover()
      await expect(link).toBeVisible()
      await expect(
        link.locator('xpath=preceding-sibling::*[1]'),
      ).toHaveAccessibleName(/^Add .* to queue/)
      const url = await link.getAttribute('href')
      expect(url).toMatch(/^https:\/\/www\.discogs\.com\/(master|release)\//)
      const opened = page.waitForEvent('popup')
      await link.click()
      const tab = await opened
      try {
        await expect(tab).toHaveURL(url ?? '')
        expect(new URL(page.url()).searchParams.get('filters')).toBe(
          JSON.stringify(filters),
        )
      } finally {
        await tab.close()
      }
    }
  }
  await page
    .getByRole('button', { name: /Remove Discogs filter/i })
    .filter({ visible: true })
    .first()
    .click()
  await expect(page.locator('tr[data-item-index]').first()).toBeVisible()
  await expect(page.locator('.ds-play a')).toHaveCount(0)
})

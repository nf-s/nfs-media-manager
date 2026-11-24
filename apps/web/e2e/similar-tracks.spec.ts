import { expect, test } from '@playwright/test'

test('Similar tracks open discovered track, artist and album inspectors', async ({
  page,
}) => {
  await page.goto('/tracks?view=list&q=Hidden+Letter')
  await page.getByRole('link', { name: 'Hidden Letter', exact: true }).click()
  await page.getByRole('tab', { name: 'Similar', exact: true }).click()

  const row = page
    .getByLabel('Similar tracks', { exact: true })
    .locator('.ds-row')
    .filter({ hasText: 'Tidal Basin Edit' })
  const title = row.getByRole('link', { name: 'Tidal Basin Edit', exact: true })
  await expect(title).toBeVisible()
  await title.focus()
  await expect(
    row.getByRole('button', { name: /Play Tidal Basin Edit/ }),
  ).toBeDisabled()
  await expect(
    row.getByRole('button', { name: /Add Tidal Basin Edit to queue/ }),
  ).toBeDisabled()
  await expect(
    row.getByLabel('Add track to library · Tidal Basin Edit'),
  ).toBeVisible()
  await expect(row.getByText('Unavailable')).toBeVisible()

  await row.getByRole('link', { name: 'Halden Row', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Halden Row' })).toBeVisible()
  await page.goBack()

  await row.getByRole('link', { name: 'Harbour Current', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Harbour Current' }),
  ).toBeVisible()
  await page.goBack()

  await row
    .getByRole('link', { name: 'Open details for Tidal Basin Edit' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Tidal Basin Edit' }),
  ).toBeVisible()
})

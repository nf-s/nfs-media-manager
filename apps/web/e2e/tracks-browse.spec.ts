import { expect, test } from '@playwright/test'
import { applyFieldFilter, readCount, selectRows, urlFilters } from './preview'

const filteredCount = /^[\d,]+ of [\d,]+ tracks$/

test('Tracks Browse filters by a field, selects rows and keeps the filter on reload', async ({
  page,
}) => {
  await page.goto('/tracks')
  await expect(page.getByText(/^[\d,]+ tracks$/)).toBeVisible()

  await applyFieldFilter(page, 'Halden', 'Artists: Halden Row')
  await expect(
    page.getByRole('button', { name: 'Remove Halden Row filter' }),
  ).toBeVisible()
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Halden Row' }])
  await expect(page.getByText(filteredCount)).toBeVisible()
  const [matching = 0, total = 0] = await readCount(page, filteredCount)
  expect(matching).toBeGreaterThan(1)
  expect(matching).toBeLessThan(total)

  await selectRows(page, 2, matching)

  await page.reload()
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Halden Row' }])
  await expect(
    page.getByRole('button', { name: 'Remove Halden Row filter' }),
  ).toBeVisible()
  await expect(
    page.getByText(
      `${matching.toLocaleString('en')} of ${total.toLocaleString('en')} tracks`,
    ),
  ).toBeVisible()
  await selectRows(page, 1, matching)
})

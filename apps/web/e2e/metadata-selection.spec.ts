import { expect, test } from '@playwright/test'
import { applyFieldFilter, readCount, selectRows, urlFilters } from './preview'

const trackCount = /^[\d,]+ tracks$/

test('Metadata selection filters tracks by a field, selects rows and keeps the filter on reload', async ({
  page,
}) => {
  await page.goto('/jobs/metadata?mediaType=track')
  await expect(page.getByText(trackCount)).toBeVisible()
  const [before = 0] = await readCount(page, trackCount)

  await applyFieldFilter(page, 'Ines', 'Artists: Ines Marlowe')
  await expect(
    page.getByRole('button', { name: 'Remove Ines Marlowe filter' }),
  ).toBeVisible()
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Ines Marlowe' }])
  await expect
    .poll(async () => (await readCount(page, trackCount))[0])
    .toBeLessThan(before)
  const [matching = 0] = await readCount(page, trackCount)
  expect(matching).toBeGreaterThan(1)

  await selectRows(page, 2, matching)

  await page.reload()
  expect(new URL(page.url()).searchParams.get('mediaType')).toBe('track')
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Ines Marlowe' }])
  await expect(
    page.getByRole('button', { name: 'Remove Ines Marlowe filter' }),
  ).toBeVisible()
  await expect(
    page.getByText(`${matching.toLocaleString('en')} tracks`),
  ).toBeVisible()
  await selectRows(page, 1, matching)
})

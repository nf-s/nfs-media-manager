import { expect, test } from '@playwright/test'
import { urlFilters } from './preview'

test('Albums playlist headers and Filters share a query that survives reload', async ({
  page,
}) => {
  await page.goto('/playlists?mediaType=album')
  const table = page.getByRole('table', { name: 'Playlists' })
  const smart = table.getByRole('link', { name: 'Dream Pop, Newest First' })
  const ordinary = table.getByRole('link', { name: 'Rainy Sundays' })
  await expect(ordinary).toBeVisible()
  await table.getByRole('button', { name: 'Filter Type', exact: true }).click()
  const header = page.getByRole('dialog', { name: 'Filter Type', exact: true })
  await header.getByRole('checkbox', { name: 'Smart playlist' }).check()
  await header.press('Escape')
  await expect(smart).toBeVisible()
  await expect(ordinary).toHaveCount(0)

  const showFilters = page.getByRole('button', {
    name: /^Filters, columns and grid size/,
  })
  await showFilters.click()
  const drawer = page.getByRole('dialog', { name: 'Filters and view' })
  await expect(
    drawer.getByRole('checkbox', { name: 'Smart playlist' }),
  ).toBeChecked()
  const column = drawer.getByRole('combobox', { name: 'Column', exact: true })
  await column.selectOption('savedView')
  await drawer
    .getByRole('searchbox', { name: 'Saved view contains' })
    .fill('Dream Pop · Added, newest first')
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click()
  await drawer.getByRole('button', { name: 'Close filters' }).click()
  await expect(page.getByText('1 playlist', { exact: true })).toBeVisible()
  await expect(smart).toBeVisible()
  await page.reload()
  await expect(smart).toBeVisible()
  await expect(page.getByText('1 playlist', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove Saved view filter' }).click()
  await page.getByRole('button', { name: 'Remove Type filter' }).click()
  await expect(ordinary).toBeVisible()
})

test('hidden columns can narrow the directory alongside an album count range', async ({
  page,
}) => {
  await page.goto('/playlists?mediaType=album')
  const table = page.getByRole('table', { name: 'Playlists' })
  await expect(
    table.getByRole('link', { name: 'Morning Commute', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: /^Filters, columns and grid size/ })
    .click()
  const drawer = page.getByRole('dialog', { name: 'Filters and view' })
  const column = drawer.getByRole('combobox', { name: 'Column', exact: true })
  await expect(column.locator('option')).toHaveText([
    'Playlist',
    'Type',
    'Source',
    'Albums',
    'Saved view',
    'Updated',
    'Owner',
    'Tracks',
    'In album library',
    'Imported albums',
    'Duration',
    'Imported',
    'Schedule',
    'Last checked',
    'Added to library',
    'Description',
    'Next import',
  ])
  await column.selectOption('owner')
  await drawer
    .getByRole('searchbox', { name: 'Owner contains' })
    .fill('preview owner')
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click()
  await column.selectOption('count')
  await drawer.getByRole('spinbutton', { name: 'Albums minimum' }).fill('0')
  await drawer.getByRole('button', { name: 'Apply range' }).click()
  await drawer.getByRole('button', { name: 'Close filters' }).click()
  await expect(page.getByText('1 playlist', { exact: true })).toBeVisible()
  await expect(
    table.getByRole('link', { name: 'Morning Commute', exact: true }),
  ).toBeVisible()
  await expect(
    table.getByRole('button', { name: 'Filter Owner', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove Owner filter' }).click()
  await expect(table.getByRole('link', { name: 'Rainy Sundays' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Remove Albums filter' }),
  ).toBeVisible()
})

for (const [scope, library, playlist] of [
  ['album', 'Albums', 'Rainy Sundays'],
  ['track', 'Tracks', 'Late Shift'],
] as const) {
  test(`saved playlist contents opens scoped ${library} Browse`, async ({
    page,
  }) => {
    await page.goto(`/playlists?mediaType=${scope}`)
    await page
      .getByRole('table', { name: 'Playlists' })
      .getByRole('link', { name: playlist })
      .click()
    const show = page.getByRole('link', {
      name: `Show in ${library}`,
      exact: true,
    })
    await expect(show).toBeVisible()
    await show.click()
    await expect(
      page.getByRole('combobox', { name: 'Search and filter library' }),
    ).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(`/${library.toLowerCase()}`)
    expect(urlFilters(page)).toEqual([
      { field: 'libraryPlaylist', value: expect.any(String), mode: 'required' },
    ])
  })
}

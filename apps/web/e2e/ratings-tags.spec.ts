import { expect, test } from '@playwright/test'
import { z } from 'zod'
import {
  RatingsRankingPageSchema,
  RatingsRankingRequestSchema,
  type RatingsRankingRequest,
} from '@repo/schemas/ratings-explorer'

const rankingResponse = z.object({ data: RatingsRankingPageSchema })

test('a selected tag outside the first suggestions stays active as the list loads', async ({
  page,
}) => {
  let releaseBlank = () => {}
  const blank = new Promise<void>((resolve) => {
    releaseBlank = resolve
  })
  await page.route('**/albums/facets?**', async (route) => {
    const search = new URL(route.request().url()).searchParams.get('q')
    if (!search) await blank
    const value = search ? 'rare tag' : 'common tag'
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: [{ field: 'genre', value, label: value, count: 1 }],
      },
    })
  })
  try {
    await page.goto('/albums/ratings')
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    const form = page.getByRole('form', { name: 'Rating filters' })
    const draft = form.getByRole('combobox', { name: 'Find a tag' })
    const list = form.getByRole('listbox', { name: 'Tag', exact: true })
    const active = list.locator('[data-active]')
    const selected = form.getByRole('button', {
      name: 'Tag: Rare Tag',
      exact: true,
    })
    await form.getByRole('button', { name: 'Tag: Any' }).click()
    await draft.fill('rare')
    await expect(active).toHaveText('Rare Tag')
    await draft.press('Enter')
    await selected.click()
    await expect(active).toHaveText('Rare Tag')
    await expect(active).toHaveAttribute('aria-selected', 'true')
    await draft.press('ArrowDown')
    await expect(active).toHaveText('Any')
    releaseBlank()
    await expect(list.getByRole('option', { name: 'Common Tag' })).toBeVisible()
    await expect(active).toHaveText('Any')
    await draft.press('ArrowUp')
    await expect(active).toHaveText('Rare Tag')
    await draft.press('Enter')
    await selected.click()
    await expect(active).toHaveText('Rare Tag')
    await draft.press('ArrowUp')
    await expect(active).toHaveText('Common Tag')
    await draft.press('Enter')
    await expect(
      form.getByRole('button', { name: 'Tag: Common Tag' }),
    ).toBeVisible()
  } finally {
    releaseBlank()
  }
})

test('Albums distinguishes an artist tag from an album tag with the same name', async ({
  page,
}) => {
  await page.route('**/albums/facets?**', (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: ['genre', 'artistTag'].map((field) => ({
          field,
          value: 'fixture tag',
          label: 'Fixture Tag',
          count: 2,
        })),
      },
    }),
  )
  await page.goto('/albums/ratings')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  const filters = page.getByRole('form', { name: 'Rating filters' })
  await filters.getByRole('button', { name: 'Tag: Any' }).click()
  for (const { label, tagField } of [
    { label: 'Fixture Tag (artist tag)', tagField: 'artistTag' },
    { label: 'Fixture Tag', tagField: undefined },
  ]) {
    const [applied] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().endsWith('/ratings/ranking') &&
          r.method() === 'POST' &&
          RatingsRankingRequestSchema.parse(r.postDataJSON()).tag ===
            'fixture tag',
      ),
      filters.getByRole('option', { name: label, exact: true }).click(),
    ])
    expect(
      RatingsRankingRequestSchema.parse(applied.postDataJSON()).tagField,
    ).toBe(tagField)
    if (tagField)
      await filters.getByRole('button', { name: 'Tag: ' + label }).click()
  }
})

for (const library of ['albums', 'films']) {
  test(`${library} ranks only a selected tag and reuses the same result for its pill`, async ({
    page,
  }) => {
    const requests: RatingsRankingRequest[] = []
    const suggestions: string[] = []
    let releaseInitial = () => {}
    const initialSuggestions = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    await page.route(`**/${library}/facets?**`, async (route) => {
      if (!new URL(route.request().url()).searchParams.get('q'))
        await initialSuggestions
      await route.continue()
    })
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/ratings/ranking'))
        requests.push(RatingsRankingRequestSchema.parse(req.postDataJSON()))
      if (req.url().includes(`/${library}/facets?`))
        suggestions.push(new URL(req.url()).searchParams.get('q') ?? '')
    })
    const response = () =>
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/ratings/ranking'),
      )
    const [initialResponse] = await Promise.all([
      response(),
      page.goto(`/${library}/ratings`),
    ])
    const { data: initial } = rankingResponse.parse(
      await initialResponse.json(),
    )
    const table = page.getByRole('region', { name: /rankings$/i })
    const pill = table.locator('button[title^="Tag: "]').first()
    await expect(pill).toBeAttached()
    const title = await pill.getAttribute('title')
    if (!title) throw new Error('Expected a ranked item with a tag')
    const label = title.slice('Tag: '.length)
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    const tag = page.getByRole('button', { name: 'Tag: Any', exact: true })
    const draft = page.getByRole('combobox', { name: 'Find a tag' })
    const absent = 'fixture-incomplete-tag-x'
    try {
      await tag.click()
      await draft.fill(absent)
      await expect(page.getByText('No matching tags.')).toBeVisible()
      await expect(draft).toHaveValue(absent)
    } finally {
      releaseInitial()
    }
    await draft.press('Enter')
    expect(suggestions).toContain(absent)
    expect(requests.map((r) => r.tag)).toEqual([''])
    await expect(tag).toHaveText('Any')
    await draft.fill(label)
    const choice = page.getByRole('option', { name: label, exact: true })
    await expect(choice).toBeVisible()
    expect(requests).toHaveLength(1)
    const [filteredResponse] = await Promise.all([response(), choice.click()])
    const { data: filtered } = rankingResponse.parse(
      await filteredResponse.json(),
    )
    expect(filtered.total).toBeGreaterThan(0)
    expect(filtered.total).toBeLessThan(initial.total)
    expect(requests).toHaveLength(2)
    const selected = requests[1]
    if (!selected?.tag)
      throw new Error('Missing selected tag in ranking request')
    const filters = page.getByRole('form', { name: 'Rating filters' })
    const selectedTag = filters.getByRole('button', {
      name: title,
      exact: true,
    })
    await selectedTag.click()
    await expect(
      page.getByRole('option', { name: label, exact: true }),
    ).toHaveAttribute('data-active', '')
    await draft.press('Enter')
    await selectedTag.click()
    await page
      .getByRole('listbox', { name: 'Tag', exact: true })
      .getByRole('option', { name: 'Any', exact: true })
      .click()
    await expect(tag).toBeVisible()
    const count = (n: number) =>
      `${n.toLocaleString('en')} of ${initial.libraryTotal.toLocaleString('en')}`
    await expect(
      page.getByText(count(initial.matchingTotal), { exact: true }),
    ).toBeVisible()
    await table.getByTitle(title, { exact: true }).first().click()
    await expect(selectedTag).toBeVisible()
    await expect(
      page.getByText(count(filtered.matchingTotal), { exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: `Clear ${label}`, exact: true })
      .click()
    await expect(tag).toBeVisible()
    await expect(
      page.getByText(count(initial.matchingTotal), { exact: true }),
    ).toBeVisible()
    expect(requests).toHaveLength(2)
  })
}

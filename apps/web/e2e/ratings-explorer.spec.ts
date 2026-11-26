import { expect, test } from '@playwright/test'
import {
  RatingsRankingRequestSchema,
  type RatingsRankingRequest,
  type RatingsRankingPage,
  RatingsRankingPageSchema,
  RatingsSourcesPageSchema,
} from '@repo/schemas/ratings-explorer'
import { z } from 'zod'

const source = {
  key: 'ratingFixture',
  label: 'Fixture rating',
  hasVotes: true,
  votesKey: 'ratingFixtureVotes',
  scale: 10,
  group: 'audience',
} satisfies RatingsRankingPage['sources'][number]

for (const library of ['film', 'album']) {
  test(
    library +
      ' Sources opens real matching Ranking rows from a bin and a range',
    async ({ page }) => {
      const reads: string[] = []
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (request.method() === 'POST' && path.startsWith('/api/v1/ratings/'))
          reads.push(path.split('/').at(-1) ?? '')
      })
      const response = (view: string) =>
        page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.url().endsWith('/ratings/' + view),
        )
      await Promise.all([
        response('ranking'),
        page.goto('/' + library + 's/ratings'),
      ])
      await page.getByRole('button', { name: /^Filters, columns/ }).click()
      const filters = page.getByRole('dialog', { name: 'Filters and view' })
      await filters.getByLabel('From year').fill('1900')
      await Promise.all([
        response('ranking'),
        filters.getByRole('button', { name: 'Apply filters' }).click(),
      ])
      await filters.getByRole('button', { name: 'Close filters' }).click()
      const views = page.getByRole('group', { name: 'Ratings view' })
      const began = Date.now()
      const [summaryResponse] = await Promise.all([
        response('sources'),
        views.getByRole('button', { name: 'Sources' }).click(),
      ])
      const { data: summary } = z
        .object({ data: RatingsSourcesPageSchema })
        .parse(await summaryResponse.json())
      const chart = page.getByRole('group', {
        name: 'Combined score distribution',
      })
      await expect(chart).toBeVisible()
      test.info().annotations.push({
        type: 'Sources visible',
        description: String(Date.now() - began) + ' ms',
      })
      const score = summary.histograms.find((h) => h.dimension === 'score')
      if (!score) throw new Error('Missing score histogram')
      const first = score.bins.findIndex((bin) => bin.count > 0)
      expect(first).toBeGreaterThanOrEqual(0)
      expect(reads).toEqual(['ranking', 'ranking', 'sources'])
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
      const [rankedResponse] = await Promise.all([
        response('ranking'),
        chart.getByRole('button').nth(first).click(),
      ])
      const { data: ranked } = z
        .object({ data: RatingsRankingPageSchema })
        .parse(await rankedResponse.json())
      expect(ranked.total).toBe(score.bins[first]?.count)
      const row = ranked.rows[0]
      if (!row) throw new Error('Expected a matching title')
      await expect(
        page.getByRole('button', { name: row.title, exact: true }).first(),
      ).toBeVisible()
      await page
        .getByRole('button', { name: 'Edit Combined score range' })
        .click()
      await expect(chart).toBeVisible()
      const from = Math.max(0, first - 1)
      const through = Math.min(first + 1, score.bins.length - 1)
      await page.getByLabel('From bin').selectOption({ index: from })
      await page.getByLabel('Through bin').selectOption({ index: through })
      const [rangeResponse] = await Promise.all([
        response('ranking'),
        page.getByRole('button', { name: 'Show in Ranking' }).click(),
      ])
      const { data: rangeRows } = z
        .object({ data: RatingsRankingPageSchema })
        .parse(await rangeResponse.json())
      expect(rangeRows.total).toBe(
        score.bins
          .slice(from, through + 1)
          .reduce((sum, bin) => sum + bin.count, 0),
      )
      expect(
        RatingsRankingRequestSchema.parse(
          rangeResponse.request().postDataJSON(),
        ),
      ).toMatchObject({
        yearFrom: 1900,
        ranges: [{ dimension: 'score', first: from, last: through }],
      })
      expect(reads).toEqual([
        'ranking',
        'ranking',
        'sources',
        'ranking',
        'sources',
        'ranking',
      ])
      await page
        .getByRole('button', { name: 'Clear Combined score range' })
        .click()
      await expect(
        page.getByRole('button', { name: 'Edit Combined score range' }),
      ).toHaveCount(0)
    },
  )
}

function ranking(request: RatingsRankingRequest): RatingsRankingPage {
  const total = request.search ? 1 : 120
  const length = Math.max(0, Math.min(request.limit, total - request.offset))
  const sources: RatingsRankingPage['sources'] = [
    source,
    {
      key: 'ratingPanel',
      label: 'Panel',
      scale: 100,
      hasVotes: false,
      group: 'critics',
    },
    ...(request.library === 'film'
      ? [
          {
            key: 'mine',
            label: 'Personal',
            scale: 10,
            hasVotes: false,
            group: 'personal',
          } satisfies RatingsRankingPage['sources'][number],
        ]
      : []),
  ]
  return {
    total,
    sources,
    rows: Array.from({ length }, (_, i) => ({
      id: 'fixture-' + (request.offset + i),
      title: (request.search || 'Fixture') + ' ' + (request.offset + i + 1),
      year: 2010,
      score: 80,
      core: 80,
      counted: 2,
      spread: 0,
      criticGap: 0,
      personalGap: request.library === 'film' ? 0 : null,
      observedWeight:
        (request.settings.sources.find((setting) => setting.key === source.key)
          ?.weight ?? 1) + 1,
      missingWeight: 0,
      missingSum: 0,
      ratings: sources.map((s) => ({
        key: s.key,
        raw: 0.8 * s.scale,
        adjusted: 80,
        votes: s.hasVotes ? 9 : null,
        center: 70,
        status: s.group === 'personal' ? 'disabled' : 'counted',
      })),
    })),
  }
}

test('sort shows the outstanding read and its result on the direction button', async ({
  page,
}) => {
  let releaseRead = () => {}
  const held = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let hold = false
  await page.route('**/api/v1/ratings/ranking', async (route) => {
    const request = RatingsRankingRequestSchema.parse(
      route.request().postDataJSON(),
    )
    if (hold) await held
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data: ranking(request) },
    })
  })
  await page.goto('/films/ratings')
  await expect(
    page.getByRole('button', { name: 'Fixture 1', exact: true }),
  ).toBeVisible()
  const direction = page.getByRole('button', { name: /Sort direction:/ })
  const idle = await direction.boundingBox()
  expect(idle).not.toBeNull()
  hold = true
  try {
    await direction.click()
    await expect(direction).toHaveAttribute('data-feedback', 'pending')
    await expect(direction).toHaveAccessibleName(/Updating…/)
    expect(await direction.boundingBox()).toEqual(idle)
  } finally {
    releaseRead()
  }
  await expect(direction).toHaveAttribute('data-feedback', 'done')
  await expect(direction).toHaveAccessibleName(/Results updated/)
  expect(await direction.boundingBox()).toEqual(idle)
})

test('ranking reads one page per committed query and reuses calculation evidence and visited pages', async ({
  page,
}) => {
  const requests: RatingsRankingRequest[] = []
  await page.route('**/api/v1/ratings/ranking', async (route) => {
    const request = RatingsRankingRequestSchema.parse(
      route.request().postDataJSON(),
    )
    requests.push(request)
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data: ranking(request) },
    })
  })
  await page.goto('/films/ratings')
  const first = page.getByRole('button', { name: 'Fixture 1', exact: true })
  await expect(first).toBeVisible()
  await expect(
    page
      .getByRole('row')
      .filter({ has: first })
      .getByRole('cell', { name: '2 / 2', exact: true }),
  ).toHaveCount(1)
  expect(requests.map((request) => request.offset)).toEqual([0])
  await first.click()
  const calculation = page.getByRole('complementary', {
    name: 'Rating calculation',
  })
  await expect(
    calculation.getByRole('link', { name: 'Vote evidence for Fixture rating' }),
  ).toHaveAttribute('href', /ratingFixtureVotes/)
  await expect(
    calculation.getByRole('link', { name: 'Sources' }),
  ).toHaveAttribute('href', /sources/)
  await expect(calculation.getByText('2 of 2', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(first).toBeFocused()
  await page.getByRole('button', { name: 'Adjusted', exact: true }).click()
  expect(requests).toHaveLength(1)

  const slider = page.getByRole('slider', { name: 'Fixture rating' })
  await slider.focus()
  const sliderBounds = await slider.boundingBox()
  expect(sliderBounds).not.toBeNull()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await expect(slider).toHaveValue('2')
  expect(requests).toHaveLength(1)
  await page.keyboard.up('ArrowRight')
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]?.settings.sources).toEqual([
    { key: source.key, weight: 2, minVotes: 0 },
  ])
  await expect(
    page.locator('.ratings-scoring summary[data-feedback]').first(),
  ).toBeVisible()
  expect(await slider.boundingBox()).toEqual(sliderBounds)
  await expect(first).toBeVisible()
  const search = page.getByRole('searchbox', {
    name: 'Search titles or directors',
  })
  await search.pressSequentially('River', { delay: 15 })
  await expect(
    page.getByRole('button', { name: 'River 1', exact: true }),
  ).toBeVisible()
  expect(requests.map((request) => request.search)).toEqual(['', '', 'River'])
  await search.fill('')
  await expect(first).toBeVisible()
  expect(requests).toHaveLength(3)
  const table = page.getByRole('region', { name: 'Film rankings', exact: true })
  await table.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(
    page.getByRole('button', { name: 'Fixture 120', exact: true }),
  ).toBeVisible()
  expect(requests.at(-1)?.offset).toBeGreaterThan(0)
  const deepRequests = requests.length
  await table.evaluate((el) => el.scrollTo(0, 0))
  await expect(first).toBeVisible()
  expect(requests).toHaveLength(deepRequests)
  await page.goto('/albums/ratings')
  await expect(
    page.getByRole('searchbox', { name: 'Search titles or artists' }),
  ).toBeVisible()
  await expect(slider).toHaveValue('1')
  expect(requests.at(-1)?.library).toBe('album')
  await page.goto('/films/ratings')
  await expect(slider).toHaveValue('2')
  expect(requests.at(-1)?.settings.sources[0]?.weight).toBe(2)
})

test('a later search replaces an outstanding read, and a slider drag commits once', async ({
  page,
}) => {
  const requests: RatingsRankingRequest[] = []
  let finishSlowRead: (() => void) | undefined
  const slowRead = new Promise<void>((resolve) => {
    finishSlowRead = resolve
  })
  await page.route('**/api/v1/ratings/ranking', async (route) => {
    const query = RatingsRankingRequestSchema.parse(
      route.request().postDataJSON(),
    )
    requests.push(query)
    if (query.search === 'Slow') await slowRead
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data: ranking(query) },
    })
  })
  try {
    await page.goto('/albums/ratings')
    const slider = page.getByRole('slider', { name: 'Fixture rating' })
    await slider.scrollIntoViewIfNeeded()
    const box = await slider.boundingBox()
    if (!box) throw new Error('Weight slider has no bounds')
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 3, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2, y, { steps: 8 })
    await expect(slider).toHaveValue('3')
    expect(requests).toHaveLength(1)
    await page.mouse.up()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]?.settings.sources[0]?.weight).toBe(3)

    const search = page.getByRole('searchbox', {
      name: 'Search titles or artists',
    })
    await search.fill('Slow')
    await expect.poll(() => requests.at(-1)?.search).toBe('Slow')
    const aborted = page.waitForEvent(
      'requestfailed',
      (req) =>
        req.url().endsWith('/ratings/ranking') &&
        RatingsRankingRequestSchema.parse(req.postDataJSON()).search === 'Slow',
    )
    await search.fill('New')
    await aborted
    await expect(
      page.getByRole('button', { name: 'New 1', exact: true }),
    ).toBeVisible()
    finishSlowRead?.()
    await expect(
      page.getByRole('button', { name: 'Slow 1', exact: true }),
    ).toHaveCount(0)
    expect(requests.map((request) => request.search)).toEqual([
      '',
      '',
      'Slow',
      'New',
    ])
  } finally {
    finishSlowRead?.()
  }
})

test('film filters commit together, source sorts reach the server and unscored results stay accessible', async ({
  page,
}) => {
  const requests: RatingsRankingRequest[] = []
  await page.route('**/api/v1/ratings/ranking', async (route) => {
    const request = RatingsRankingRequestSchema.parse(
      route.request().postDataJSON(),
    )
    requests.push(request)
    const data = ranking(request)
    if (request.tag === 'Sparse') {
      if (request.scoredOnly) {
        data.rows = []
        data.total = 0
      } else {
        data.rows = data.rows
          .slice(0, 1)
          .map((item) => ({ ...item, score: null, counted: 1 }))
        data.total = data.rows.length
      }
    }
    await route.fulfill({ json: { statusCode: 200, message: 'OK', data } })
  })
  await page.goto('/films/ratings')
  await expect(
    page.getByRole('button', { name: 'Fixture 1', exact: true }),
  ).toBeVisible()
  const sort = page.getByRole('button', { name: 'Sort by: Score / 100' })
  await sort.click()
  await page.getByRole('option', { name: 'Fixture rating / 10' }).click()
  await expect.poll(() => requests.at(-1)?.sort).toBe(source.key)
  await page.getByRole('button', { name: 'Sort direction: descending' }).click()
  await expect.poll(() => requests.at(-1)?.direction).toBe('asc')
  const previous = requests.length
  await page.getByRole('button', { name: /^Filters, columns/ }).click()
  const filters = page.getByRole('dialog', { name: 'Filters and view' })
  await filters.getByLabel('Tag', { exact: true }).fill('Sparse')
  await filters.getByLabel('From year').fill('1980')
  await filters.getByLabel('Through year').fill('2010')
  await filters.getByLabel('Watched', { exact: true }).selectOption('no')
  expect(requests).toHaveLength(previous)
  await filters.getByRole('button', { name: 'Apply filters' }).click()
  await filters.getByRole('button', { name: 'Close filters' }).click()
  await expect(
    page.getByText('No matching films.', { exact: false }),
  ).toBeVisible()
  expect(requests.at(-1)).toMatchObject({
    tag: 'Sparse',
    yearFrom: 1980,
    yearTo: 2010,
    watched: false,
    scoredOnly: true,
    sort: source.key,
    direction: 'asc',
  })
  await page.getByRole('button', { name: 'Include unscored items' }).click()
  await page
    .getByRole('button', { name: 'Combined score calculation for Fixture 1' })
    .click()
  await expect(
    page.getByText('Needs 1 more qualifying rating to reach the minimum of 2.'),
  ).toBeVisible()
  expect(requests.length).toBe(previous + 2)
})

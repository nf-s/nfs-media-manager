import { expect, test } from '@playwright/test'
import {
  RatingsAgreementPageSchema,
  RatingsComparePageSchema,
  RatingsCompareRequestSchema,
} from '@repo/schemas/ratings-charts'
import {
  RatingsRankingPageSchema,
  RatingsRankingRequestSchema,
} from '@repo/schemas/ratings-explorer'
import { z } from 'zod'

for (const library of ['film', 'album']) {
  test(
    library +
      ' Agreement and Compare share the cohort and open item calculations',
    async ({ page }, info) => {
      await page.setViewportSize({
        width: info.project.name === 'phone' ? 375 : 1360,
        height: 840,
      })
      const reads: string[] = []
      const unexpected: string[] = []
      page.on('request', (req) => {
        const path = new URL(req.url()).pathname
        if (req.method() === 'POST' && path.startsWith('/api/v1/ratings/'))
          reads.push(path.split('/').at(-1) ?? '')
        if (
          /\/api\/v1\/(?:jobs|providers)\b/.test(path) &&
          req.method() !== 'GET'
        )
          unexpected.push(path)
      })
      const next = (view: string) =>
        page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.url().endsWith('/ratings/' + view),
        )
      const [ranking] = await Promise.all([
        next('ranking'),
        page.goto('/' + library + 's/ratings'),
      ])
      const { data: rank } = z
        .object({ data: RatingsRankingPageSchema })
        .parse(await ranking.json())
      const views = page.getByRole('group', { name: 'Ratings view' })
      async function followDrill(
        view: 'ranking' | 'compare',
        click: () => Promise<void>,
      ) {
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        await page.route(
          '**/ratings/' + view,
          async (route) => {
            await held
            await route.continue()
          },
          { times: 1 },
        )
        const destination = views.getByRole('button', {
          name: new RegExp(view, 'i'),
        })
        try {
          await click()
          await expect(destination).toHaveAttribute('data-feedback', 'pending')
          await expect(
            page.locator('.ratings-page [data-feedback="pending"]'),
          ).toHaveCount(1)
        } finally {
          release()
        }
        await expect(destination).toHaveAttribute('data-feedback', 'done')
      }
      const [agreement] = await Promise.all([
        next('agreement'),
        views.getByRole('button', { name: 'Agreement' }).click(),
      ])
      const { data: a } = z
        .object({ data: RatingsAgreementPageSchema })
        .parse(await agreement.json())
      expect((await agreement.body()).byteLength).toBeLessThan(256_000)
      const matrix = page.getByRole('table', { name: 'Source agreement' })
      await expect(matrix).toBeVisible()
      await expect(
        page.getByRole('table', { name: 'Source bias' }).getByRole('row'),
      ).toHaveCount(a.sources.length + 1)
      const row = a.lists.divided[0]
      if (!row) throw new Error('The disposable preview needs a divided item')
      const readsBeforeOpen = reads.length
      await page
        .getByRole('table', { name: 'Most divided', exact: true })
        .getByRole('button', { name: row.title, exact: true })
        .first()
        .click()
      const calculation = page.getByLabel('Rating calculation', { exact: true })
      await expect(calculation).toBeVisible()
      const extra = reads.slice(readsBeforeOpen)
      expect(extra).toEqual(
        rank.rows.some((item) => item.id === row.id) ? [] : ['calculation'],
      )
      await calculation
        .getByRole('button', { name: 'Close calculation' })
        .click()

      const pair = a.pairs.find((pair) => pair.correlation !== null)
      const xLabel = a.sources.find((source) => source.key === pair?.x)?.label
      const yLabel = a.sources.find((source) => source.key === pair?.y)?.label
      const start = reads.length
      const [compared] = await Promise.all([
        next('compare'),
        followDrill('compare', () =>
          pair
            ? matrix
                .getByRole('button', { name: xLabel + ' and ' + yLabel + ':' })
                .click()
            : views.getByRole('button', { name: 'Compare' }).click(),
        ),
      ])
      const { data: c } = z
        .object({ data: RatingsComparePageSchema })
        .parse(await compared.json())
      expect(c.total).toBe(a.total)
      if (pair)
        expect(c).toMatchObject({
          x: pair.x,
          y: pair.y,
          count: pair.count,
          correlation: expect.closeTo(pair.correlation ?? 0, 7),
        })
      expect((await compared.body()).byteLength).toBeLessThan(192_000)
      const chart = page.getByRole('listbox', { name: /plotted items/ })
      await expect(chart.getByRole('option')).toHaveCount(c.points.length)
      expect(reads.slice(start)).toEqual(['compare'])
      const first = c.points[0]
      if (!first) throw new Error('The disposable preview needs a paired item')
      await chart.getByRole('option').first().click({ force: true })
      await expect(
        page.locator('.ds-rating-picked').getByRole('button', { name: 'Open' }),
      ).toBeVisible()
      await chart.focus()
      await chart.press('Home')
      await expect(chart.getByRole('option', { selected: true })).toHaveCount(1)
      await expect(page.locator('.ds-rating-picked')).toContainText(first.title)
      expect(reads.slice(start)).toEqual(['compare'])
      await chart.press('Enter')
      await expect(calculation).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(calculation).toHaveCount(0)
      const higher = page.getByRole('table', { name: / higher$/ }).first()
      await higher.getByRole('button').first().click()
      await expect(calculation).toBeVisible()
      await calculation
        .getByRole('button', { name: 'Close calculation' })
        .click()
      const beforeAxes = reads.length
      const [swapped] = await Promise.all([
        next('compare'),
        page.getByRole('button', { name: 'Swap', exact: true }).click(),
      ])
      expect(
        RatingsCompareRequestSchema.parse(swapped.request().postDataJSON()),
      ).toMatchObject({ x: c.y, y: c.x })
      await expect(page.getByLabel('Across', { exact: true })).toHaveValue(c.y)
      const [dated] = await Promise.all([
        next('compare'),
        page.getByLabel('Across', { exact: true }).selectOption('year'),
      ])
      const { data: d } = z
        .object({ data: RatingsComparePageSchema })
        .parse(await dated.json())
      expect(d.meanGap).toBeNull()
      await expect(page.getByRole('table', { name: / higher$/ })).toHaveCount(0)
      expect(reads.slice(beforeAxes)).toEqual(['compare', 'compare'])
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await views.getByRole('button', { name: 'Agreement' }).click()
      await expect(matrix).toBeVisible()
      const [sorted] = await Promise.all([
        next('ranking'),
        followDrill('ranking', () =>
          page.getByRole('button', { name: 'See all: Most divided' }).click(),
        ),
      ])
      expect(
        RatingsRankingRequestSchema.parse(sorted.request().postDataJSON()),
      ).toMatchObject({ sort: 'spread', direction: 'desc' })
      expect(unexpected).toEqual([])
      info.annotations.push({
        type: 'Chart response bytes',
        description:
          'Agreement ' +
          (await agreement.body()).byteLength +
          ', Compare ' +
          (await compared.body()).byteLength,
      })
    },
  )
}

test('a slow comparison cannot replace a newer axis selection', async ({
  page,
}) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/ratings/compare', async (route) => {
    const request = RatingsCompareRequestSchema.parse(
      route.request().postDataJSON(),
    )
    if (request.x !== 'year') return route.continue()
    await gate
    await route.fulfill({
      status: 503,
      json: { message: 'Delayed earlier selection' },
    })
  })
  try {
    await page.goto('/films/ratings')
    const views = page.getByRole('group', { name: 'Ratings view' })
    await views.getByRole('button', { name: 'Compare' }).click()
    const across = page.getByLabel('Across', { exact: true })
    await expect(across).toBeVisible()
    await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          r.url().endsWith('/ratings/compare') &&
          RatingsCompareRequestSchema.parse(r.postDataJSON()).x === 'year',
      ),
      across.selectOption('year'),
    ])
    await across.selectOption('spread')
    const chart = page.getByRole('listbox', { name: /against Spread,/ })
    await expect(chart).toBeVisible()
    release()
    await expect(across).toHaveValue('spread')
    await expect(chart).toBeVisible()
    await expect(page.getByText('Could not load rating compare.')).toHaveCount(
      0,
    )
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

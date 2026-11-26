import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { ArtistDetailSchema, ArtistSummarySchema } from '@repo/schemas/creators'
import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogResultSchema,
} from '@repo/schemas/playback'
import { webOrigin } from './preview'

const spotifyId = () => `zz${randomBytes(10).toString('hex')}`

function tracksWithArtist(id: string, query: string) {
  const params = new URLSearchParams({
    view: 'table',
    q: query,
    libraryScope: 'all',
    inspect: JSON.stringify([
      { kind: 'artist', id, view: 'tab=tracks&view=list&libraryScope=all' },
    ]),
  })
  return `/tracks?${params}`
}

test('a shadow artist merges only after review and both inspector links keep the tracks', async ({
  page,
  isMobile,
}) => {
  const token = randomBytes(4).toString('hex')
  const name = `Synthetic Coast ${token}`
  const alias = `Synthetic Inland ${token}`
  const sourceTitle = `Synthetic source track ${token}`
  const keptTitle = `Synthetic kept track ${token}`
  const differentTitle = `Synthetic unrelated track ${token}`
  const sourceProviderId = spotifyId()
  const keptProviderId = spotifyId()
  const observation = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers: { origin: webOrigin },
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'track',
            spotifyId: spotifyId(),
            title: sourceTitle,
            artists: [{ name, spotifyId: sourceProviderId }],
          },
          {
            kind: 'track',
            spotifyId: spotifyId(),
            title: keptTitle,
            artists: [{ name, spotifyId: keptProviderId }],
          },
          {
            kind: 'track',
            spotifyId: spotifyId(),
            title: differentTitle,
            artists: [{ name: alias, spotifyId: spotifyId() }],
          },
        ],
      }),
    },
  )
  expect(observation.ok()).toBe(true)
  const { data } = await observation.json()
  const [source, kept] = PlaybackCatalogResultSchema.parse(data).items
  const sourceId = source?.artists[0]?.id
  const keptId = kept?.artists[0]?.id
  if (!sourceId || !keptId || !kept)
    throw new Error('The preview did not return both artist records')
  expect(sourceId).not.toBe(keptId)
  const add = await page.request.post(
    `${webOrigin}/api/v1/catalog/media/${kept.item.id}/add`,
    { headers: { origin: webOrigin } },
  )
  expect(add.ok()).toBe(true)

  const sourceHref = tracksWithArtist(sourceId, sourceTitle)
  let releasePage: () => void = () => {}
  const heldPage = new Promise<void>((resolve) => {
    releasePage = resolve
  })
  const candidatePath = '**/api/v1/artists/browse-page?*'
  await page.route(candidatePath, async (route) => {
    const params = new URL(route.request().url()).searchParams
    if (params.get('size') !== '12' || !params.get('filters')?.includes(name))
      return route.fallback()
    if (params.get('page') === '2') {
      await heldPage
      return route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: { items: [], page: 2, size: 12, hasMore: false },
        },
      })
    }
    const response = await route.fetch()
    const payload = z
      .object({
        statusCode: z.number(),
        message: z.string(),
        data: BrowsePageSliceSchema(ArtistSummarySchema),
      })
      .parse(await response.json())
    return route.fulfill({
      response,
      json: { ...payload, data: { ...payload.data, hasMore: true } },
    })
  })
  await page.goto(sourceHref)
  const artistTracks = page.getByRole('region', { name: 'tracks list' })
  const sourceTrack = artistTracks.getByRole('link', {
    name: sourceTitle,
    exact: true,
  })
  const keptTrack = artistTracks.getByRole('link', {
    name: keptTitle,
    exact: true,
  })
  await expect(sourceTrack).toBeVisible()
  await expect(keptTrack).toHaveCount(0)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()

  const more = page
    .getByRole('button', { name: 'More actions' })
    .filter({ visible: true })
  const picker = page.getByRole('dialog', { name: `Merge “${name}” with…` })
  const review = page.getByRole('dialog', { name: 'Merge 2 artists' })
  const search = picker.getByRole('searchbox', { name: 'Search artists' })
  const confirm = review.getByRole('button', { name: 'Merge', exact: true })
  const acknowledge = review.getByRole('checkbox', {
    name: 'I confirm these profiles belong to the same artist.',
  })

  async function openPicker() {
    await more.click()
    await page.getByRole('menuitem', { name: 'Merge with…' }).click()
    await expect(search).toHaveValue(name)
  }

  await openPicker()
  const showMore = picker.getByRole('button', {
    name: 'Show more',
    exact: true,
  })
  await showMore.scrollIntoViewIfNeeded()
  const resting = await showMore.boundingBox()
  await showMore.click()
  try {
    const loading = picker.getByRole('button', {
      name: 'Loading more…',
      exact: true,
    })
    await expect(loading).toBeVisible()
    expect(await loading.boundingBox()).toEqual(resting)
  } finally {
    releasePage()
  }
  await expect(showMore).toBeHidden()
  await page.unroute(candidatePath)
  await picker
    .getByRole('button', { name: `Choose ${name} · In library`, exact: false })
    .click()
  await expect(review).toBeVisible()
  await expect(review.getByTitle(`Spotify · ${sourceProviderId}`)).toBeVisible()
  await expect(review.getByTitle(`Spotify · ${keptProviderId}`)).toBeVisible()
  if (isMobile) {
    const sourceIdentifier = `Spotify identifier for ${name} · Outside library · 1 track`
    await review.getByRole('button', { name: sourceIdentifier }).click()
    await expect(
      review.getByRole('dialog', { name: sourceIdentifier }),
    ).toHaveText(`Spotify · ${sourceProviderId}`)
    await page.keyboard.press('Escape')
    await expect(review).toBeVisible()
  }
  await expect(confirm).toBeDisabled()
  await review.getByRole('button', { name: 'Cancel' }).click()
  await expect(review).toBeHidden()
  const stillSeparate = await page.request.get(
    `${webOrigin}/api/v1/artists/${sourceId}?includeHistory=false`,
  )
  const separateArtist = ArtistDetailSchema.parse(
    (await stillSeparate.json()).data,
  )
  expect(separateArtist.id).toBe(sourceId)
  expect(separateArtist.inLibrary).toBe(false)

  await openPicker()
  await search.fill(alias)
  await picker
    .getByRole('button', { name: `Choose ${alias}`, exact: false })
    .click()
  await expect(
    review.getByText(`“${alias}”`, { exact: false }).first(),
  ).toBeVisible()
  await review.getByRole('button', { name: 'Cancel' }).click()

  await openPicker()
  await picker
    .getByRole('button', { name: `Choose ${name} · In library`, exact: false })
    .click()
  const direction = review.getByRole('combobox', { name: 'Artist to keep' })
  await direction.selectOption(keptId)
  await expect(direction).toHaveValue(keptId)
  await acknowledge.check()
  await direction.selectOption(sourceId)
  await expect(direction).toHaveValue(sourceId)
  await expect(confirm).toBeDisabled()
  await direction.selectOption(keptId)
  await expect(direction).toHaveValue(keptId)
  await acknowledge.check()
  await confirm.click()
  await expect(review).toBeHidden()
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('inspect')?.includes(keptId) ?? false,
  )
  await expect(sourceTrack).toBeVisible()
  await expect(keptTrack).toBeVisible()

  await page.reload()
  await expect(sourceTrack).toBeVisible()
  await expect(keptTrack).toBeVisible()
  await page.goto(sourceHref)
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('inspect')?.includes(keptId) ?? false,
  )
  await expect(sourceTrack).toBeVisible()
  await expect(keptTrack).toBeVisible()
  await expect(
    artistTracks.getByRole('link', { name: differentTitle }),
  ).toHaveCount(0)
})

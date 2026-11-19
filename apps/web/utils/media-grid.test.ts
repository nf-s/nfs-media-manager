import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cardGrid,
  defaultBrowseView,
  defaultGridDensity,
  formatCardDetails,
  gridCardMin,
  gridDensities,
  mediaGridGeometry,
  nestedViewKey,
  parseCardDetails,
  parseBrowseView,
  parseGridDensity,
  preserveGridScroll,
  readNestedView,
  restoreSavedBrowse,
  type GridDensity,
  type GridKind,
} from './media-grid'
import { itemGridGeometry } from './browse-items'
import { browseWindow } from './virtual-browse'

/** An in-memory stand-in for `window.localStorage`. */
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

test('cards reserve the meta line and the tags line under the creator', () => {
  const card = (extraRow: boolean, tagsBelowArtwork: boolean) =>
    mediaGridGeometry({
      width: 1000,
      mediaType: 'album',
      density: 'standard',
      extraRow,
      tagsBelowArtwork,
    }).cardHeight
  // 2px line gap and an 18px meta line (2px margin and 16px line height).
  assert.ok(Math.abs(card(true, false) - card(false, false) - 20) < 1e-9)
  // 2px line gap and a 20px pill row.
  assert.ok(Math.abs(card(true, true) - card(true, false) - 22) < 1e-9)
})

test('density accepts only known URL or persisted preference values', () => {
  for (const density of ['compact', 'standard', 'roomy']) {
    const saved = new URLSearchParams({ density, view: 'grid' }).toString()
    assert.equal(
      parseGridDensity(new URLSearchParams(saved).get('density')),
      density,
    )
  }
  for (const value of [
    null,
    undefined,
    '',
    'dense',
    'COMPACT',
    3,
    {},
    ['compact'],
  ])
    assert.equal(parseGridDensity(value), 'standard')
})

test('standard desktop geometry follows the design system card grid', () => {
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    const minimum = mediaType === 'album' ? 164 : 118
    for (const width of [701, 1000, 1440]) {
      const grid = mediaGridGeometry({ width, mediaType, density: 'standard' })
      const inner = width - cardGrid.gutter * 2
      const columns = Math.max(2, Math.floor((inner + 16) / (minimum + 16)))
      assert.equal(grid.columns, columns)
      assert.equal(grid.gap, 20)
      assert.equal(grid.columnGap, 16)
      assert.equal(grid.padding, 28)
      assert.equal(grid.mobile, false)
      const artwork = (inner - (columns - 1) * 16) / columns
      assert.ok(artwork >= minimum)
      assert.ok(
        Math.abs(
          grid.rowHeight - (artwork * (mediaType === 'album' ? 1 : 1.5) + 84),
        ) < 1e-9,
      )
    }
  }
})

test('browse view accepts grid, list and table and falls back to grid', () => {
  for (const view of ['grid', 'list', 'table'])
    assert.equal(parseBrowseView(view), view)
  for (const invalid of [null, '', 'cards', 'Table'])
    assert.equal(parseBrowseView(invalid), 'grid')
  assert.equal(parseBrowseView(null, 'list'), 'list')
  assert.equal(parseBrowseView('grid', 'list'), 'grid')
})

test('the tags line reserves one pill row in the virtual grid', () => {
  const grid = {
    width: 390,
    density: parseGridDensity(null),
    mediaType: 'album',
  } satisfies Parameters<typeof mediaGridGeometry>[0]
  assert.equal(
    mediaGridGeometry({ ...grid, tagsBelowArtwork: true }).rowHeight -
      mediaGridGeometry(grid).rowHeight,
    22,
  )
})

test('card details default to all shown and round-trip saved preferences', () => {
  assert.deepEqual(parseCardDetails(null), ['ratings', 'sort', 'tags'])
  assert.deepEqual(parseCardDetails('tags,unknown,sort'), ['tags', 'sort'])
  // An explicit empty choice must not fall back to the default.
  assert.equal(formatCardDetails([]), 'none')
  assert.deepEqual(parseCardDetails(formatCardDetails([])), [])
  assert.deepEqual(parseCardDetails(formatCardDetails(['ratings', 'tags'])), [
    'ratings',
    'tags',
  ])
})

test('a phone shows two standard columns, three compact and at least two roomy, filling the width', () => {
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    // A 375px phone leaves the grid 355px inside the page margins.
    const compact = mediaGridGeometry({
      width: 355,
      mediaType,
      density: 'compact',
    })
    const standard = mediaGridGeometry({
      width: 355,
      mediaType,
      density: 'standard',
    })
    assert.equal(compact.columns, 3)
    assert.equal(standard.columns, 2)
    assert.ok(compact.rowHeight < standard.rowHeight)
    // A detail tab on a phone is narrower than the page; compact keeps three.
    for (const [density, columns] of [
      ['compact', 3],
      ['standard', 2],
      ['roomy', 2],
    ] satisfies [GridDensity, number][])
      assert.equal(
        mediaGridGeometry({ width: 319, mediaType, density }).columns,
        columns,
      )
    for (const width of [280, 350, 390, 600, 700]) {
      for (const density of ['compact', 'standard', 'roomy']) {
        const grid = mediaGridGeometry({
          width,
          mediaType,
          density: parseGridDensity(density),
        })
        assert.equal(grid.mobile, true)
        assert.ok(grid.columns >= 2)
        const artworkWidth =
          (grid.cardHeight - 64) / (mediaType === 'album' ? 1 : 1.5)
        assert.ok(
          Math.abs(
            artworkWidth * grid.columns +
              grid.columnGap * (grid.columns - 1) +
              cardGrid.gutter * 2 -
              width,
          ) < 0.000001,
        )
        assert.equal(grid.rowHeight, grid.cardHeight + grid.gap)
      }
    }
  }
})

test('every density reserves the exact full height across distant and partial virtual rows', () => {
  for (const width of [350, 700, 1000]) {
    for (const mediaType of ['album', 'film'] satisfies Array<
      'album' | 'film'
    >) {
      for (const density of ['compact', 'standard', 'roomy']) {
        const grid = mediaGridGeometry({
          width,
          mediaType,
          density: parseGridDensity(density),
        })
        const geometry = {
          total: 10003,
          columns: grid.columns,
          rowHeight: grid.rowHeight,
          viewportHeight: 657,
        }
        const first = browseWindow({ ...geometry, scrollTop: 0 })
        for (const scrollTop of [0, 90000, 9999999]) {
          const window = browseWindow({ ...geometry, scrollTop })
          const renderedRows = Math.ceil(
            (window.end - window.start) / grid.columns,
          )
          const measuredHeight =
            window.padTop +
            renderedRows * grid.cardHeight +
            Math.max(0, renderedRows - 1) * grid.gap +
            window.padBottom
          assert.ok(
            Math.abs(measuredHeight - (first.height - grid.gap)) < 0.000001,
          )
          assert.equal(window.height, first.height)
          assert.equal(window.start % grid.columns, 0)
          assert.ok(window.end <= geometry.total)
          assert.ok(
            window.end - window.start <=
              (Math.ceil(657 / grid.rowHeight) + 9) * grid.columns,
          )
          if (scrollTop === 9999999) {
            assert.equal(window.end, geometry.total)
            assert.equal(window.padBottom, 0)
            assert.ok(window.pages.every((page) => page >= 100))
          }
        }
        const empty = browseWindow({ ...geometry, total: 0, scrollTop: 0 })
        assert.equal(Math.max(0, empty.height - grid.gap), 0)
      }
    }
  }
})

test('density and width changes preserve the visible item and fractional row offset', () => {
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    for (const from of ['compact', 'standard', 'roomy']) {
      const previous = mediaGridGeometry({
        width: 350,
        mediaType,
        density: parseGridDensity(from),
      })
      for (const to of ['compact', 'standard', 'roomy']) {
        for (const width of [350, 1000]) {
          const next = mediaGridGeometry({
            width,
            mediaType,
            density: parseGridDensity(to),
          })
          for (const row of [0, 0.25, 100.5, 987]) {
            const top = preserveGridScroll(
              row * previous.rowHeight,
              previous,
              next,
            )
            const firstItem = Math.floor(row) * previous.columns
            const nextRow = Math.floor(top / next.rowHeight + 0.000001)
            assert.ok(nextRow * next.columns <= firstItem)
            assert.ok((nextRow + 1) * next.columns > firstItem)
            assert.ok(
              Math.abs(top / next.rowHeight - nextRow - (row % 1)) < 0.000001,
            )
            const window = browseWindow({
              total: 10003,
              columns: next.columns,
              rowHeight: next.rowHeight,
              scrollTop: top,
              viewportHeight: 657,
            })
            assert.ok(window.start <= firstItem && window.end > firstItem)
          }
        }
      }
    }
  }
})

test('unchanged geometry preserves the exact scroll position for modal return', () => {
  const grid = mediaGridGeometry({
    width: 350,
    mediaType: 'album',
    density: 'compact',
  })
  for (const top of [0, 1234.56789, 987654.321])
    assert.equal(preserveGridScroll(top, grid, grid), top)
})

test('tracks start in Table, albums and films in Grid, other lists keep their own default', () => {
  assert.equal(defaultBrowseView('track'), 'table')
  assert.equal(defaultBrowseView('album'), 'grid')
  assert.equal(defaultBrowseView('film'), 'grid')
  assert.equal(defaultBrowseView('subscription'), 'table')
  assert.equal(defaultBrowseView('artist', 'list'), 'list')
  assert.equal(defaultBrowseView('person'), 'table')
  // A view named in the URL still wins over the default.
  assert.equal(parseBrowseView('list', defaultBrowseView('track')), 'list')
})

test('a view saved under the old defaults is dropped once; later choices and other state stay', () => {
  for (const library of ['tracks', 'albums', 'films']) {
    const storage = memoryStorage({
      [`browse:${library}`]: 'view=list&sortBy=title&density=roomy',
    })
    assert.equal(
      restoreSavedBrowse(storage, library),
      'sortBy=title&density=roomy',
    )
    assert.equal(
      storage.values.get(`browse:${library}`),
      'sortBy=title&density=roomy',
    )
    // A view chosen after the change is kept on every later visit.
    storage.setItem(`browse:${library}`, 'view=list&sortBy=title')
    assert.equal(restoreSavedBrowse(storage, library), 'view=list&sortBy=title')
    assert.equal(restoreSavedBrowse(storage, library), 'view=list&sortBy=title')
  }
  // Only a stored view is dropped; nothing stored stays nothing.
  const empty = memoryStorage()
  assert.equal(restoreSavedBrowse(empty, 'tracks'), null)
  const onlyView = memoryStorage({ 'browse:tracks': 'view=grid' })
  assert.equal(restoreSavedBrowse(onlyView, 'tracks'), '')
  // Artists and Subscriptions keep their defaults, so their saved view stays.
  for (const library of ['artists', 'subscriptions']) {
    const storage = memoryStorage({ [`browse:${library}`]: 'view=grid' })
    assert.equal(restoreSavedBrowse(storage, library), 'view=grid')
  }
})

test('a nested view stored under the old key is discarded for the new default', () => {
  const storage = memoryStorage({
    'nested-media-view:playlist-entries': 'list',
    'nested-media-view:creator-library-album': 'table',
  })
  assert.equal(readNestedView(storage, 'playlist-entries', 'table'), 'table')
  assert.equal(
    readNestedView(
      storage,
      'creator-library-album',
      defaultBrowseView('album'),
    ),
    'grid',
  )
  assert.equal(storage.values.has('nested-media-view:playlist-entries'), false)
  storage.setItem(nestedViewKey('playlist-entries'), 'list')
  assert.equal(readNestedView(storage, 'playlist-entries', 'table'), 'list')
  storage.setItem(nestedViewKey('collection-films'), 'bogus')
  assert.equal(readNestedView(storage, 'collection-films', 'grid'), 'grid')
})

test('phones start compact and wider screens standard unless a density is named', () => {
  assert.equal(defaultGridDensity(true), 'compact')
  assert.equal(defaultGridDensity(false), 'standard')
  assert.equal(parseGridDensity(null, defaultGridDensity(true)), 'compact')
  assert.equal(parseGridDensity('bogus', defaultGridDensity(true)), 'compact')
  assert.equal(parseGridDensity('roomy', defaultGridDensity(true)), 'roomy')
  assert.equal(
    parseGridDensity('standard', defaultGridDensity(true)),
    'standard',
  )
  assert.deepEqual(gridDensities, ['compact', 'standard', 'roomy'])
})

test('every Browse grid has three densities: three phone columns compact, the design width standard', () => {
  const kinds = [
    ['album', 164],
    ['track', 164],
    ['film', 118],
    ['artist', 120],
    ['subscription', 200],
  ] satisfies [GridKind, number][]
  for (const [kind, standard] of kinds) {
    assert.equal(gridCardMin(kind, 'standard'), standard)
    assert.ok(gridCardMin(kind, 'compact') < standard)
    assert.ok(gridCardMin(kind, 'roomy') > standard)
    const phone = (density: (typeof gridDensities)[number]) =>
      itemGridGeometry({ width: 355, min: gridCardMin(kind, density) })
    assert.equal(phone('compact').columns, 3)
    assert.equal(phone('standard').columns, 2)
    assert.equal(phone('roomy').columns, 2)
    // Columns never exceed the width, so the page never scrolls sideways.
    for (const width of [320, 355, 375, 701, 1000, 1440])
      for (const density of gridDensities) {
        const { columns } = itemGridGeometry({
          width,
          min: gridCardMin(kind, density),
        })
        const card = (width - 24 - (columns - 1) * 16) / columns
        assert.ok(card > 0)
        assert.ok(columns === 2 || card >= gridCardMin(kind, density))
      }
    // Denser grids have more columns and shorter rows at the same width.
    const [compact, standardGrid, roomy] = gridDensities.map((density) =>
      itemGridGeometry({ width: 1200, min: gridCardMin(kind, density) }),
    )
    assert.ok(compact && standardGrid && roomy)
    assert.ok(compact.columns > standardGrid.columns)
    assert.ok(standardGrid.columns > roomy.columns)
    assert.ok(compact.rowHeight < standardGrid.rowHeight)
    assert.ok(standardGrid.rowHeight < roomy.rowHeight)
  }
  for (const mediaType of ['album', 'film'] satisfies ('album' | 'film')[])
    for (const density of gridDensities)
      assert.equal(
        mediaGridGeometry({ width: 1000, mediaType, density }).columns,
        itemGridGeometry({ width: 1000, min: gridCardMin(mediaType, density) })
          .columns,
      )
})

test('mix grids use the square album card widths', () => {
  for (const density of gridDensities)
    assert.equal(gridCardMin('mix', density), gridCardMin('album', density))
})

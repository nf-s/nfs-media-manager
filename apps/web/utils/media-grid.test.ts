import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cardGrid,
  formatCardDetails,
  mediaGridGeometry,
  parseCardDetails,
  parseBrowseView,
  parseGridDensity,
  preserveGridScroll,
} from './media-grid'
import { browseWindow } from './virtual-browse'

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
    const compact = mediaGridGeometry({
      width: 375,
      mediaType,
      density: 'compact',
    })
    const standard = mediaGridGeometry({
      width: 375,
      mediaType,
      density: 'standard',
    })
    assert.equal(compact.columns, 3)
    assert.equal(standard.columns, 2)
    assert.ok(compact.rowHeight < standard.rowHeight)
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

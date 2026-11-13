import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatArtworkOverlays,
  mediaGridGeometry,
  parseArtworkOverlays,
  parseBrowseView,
  parseGridDensity,
  preserveGridScroll,
} from './media-grid'
import { browseWindow } from './virtual-browse'

test('tiles are shorter when the sort value and links sit on the artwork', () => {
  const tile = (extraRow: boolean) =>
    mediaGridGeometry({
      width: 1000,
      mediaType: 'album',
      density: 'standard',
      extraRow,
    }).cardHeight
  assert.equal(tile(true) - tile(false), 20)
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

test('standard desktop geometry preserves existing album and film layouts', () => {
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    for (const width of [701, 1000, 1440]) {
      const grid = mediaGridGeometry({ width, mediaType, density: 'standard' })
      const columns = Math.max(
        2,
        Math.floor(width / (mediaType === 'album' ? 182 : 152)),
      )
      assert.equal(grid.columns, columns)
      assert.equal(grid.gap, 12)
      assert.equal(grid.mobile, false)
      assert.equal(
        grid.rowHeight,
        ((width - (columns - 1) * 12) / columns) *
          (mediaType === 'album' ? 1 : 1.5) +
          76,
      )
    }
  }
})

test('browse view accepts grid, list and table and falls back to grid', () => {
  for (const view of ['grid', 'list', 'table'])
    assert.equal(parseBrowseView(view), view)
  for (const invalid of [null, '', 'cards', 'Table'])
    assert.equal(parseBrowseView(invalid), 'grid')
})

test('artwork overlays default per library and round-trip saved preferences', () => {
  assert.deepEqual(parseArtworkOverlays(null, 'album'), [
    'ratings',
    'sort',
    'tags',
  ])
  assert.deepEqual(parseArtworkOverlays(null, 'film'), ['ratings', 'sort'])
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    assert.deepEqual(parseArtworkOverlays('tags,unknown,sort', mediaType), [
      'tags',
      'sort',
    ])
    // An explicit empty choice must not fall back to the library default.
    assert.equal(formatArtworkOverlays([]), 'none')
    assert.deepEqual(
      parseArtworkOverlays(formatArtworkOverlays([]), mediaType),
      [],
    )
    assert.deepEqual(
      parseArtworkOverlays(
        formatArtworkOverlays(['ratings', 'tags']),
        mediaType,
      ),
      ['ratings', 'tags'],
    )
  }
})

test('mobile density supports four compact, three standard and at least two roomy columns with bounded metadata', () => {
  for (const mediaType of ['album', 'film'] satisfies Array<'album' | 'film'>) {
    const compact = mediaGridGeometry({
      width: 350,
      mediaType,
      density: 'compact',
    })
    const standard = mediaGridGeometry({
      width: 350,
      mediaType,
      density: 'standard',
    })
    assert.equal(compact.columns, 4)
    assert.equal(standard.columns, 3)
    assert.ok(compact.rowHeight < standard.rowHeight)
    for (const width of [280, 350, 390, 600, 700]) {
      for (const density of ['compact', 'standard', 'roomy']) {
        const grid = mediaGridGeometry({
          width,
          mediaType,
          density: parseGridDensity(density),
        })
        assert.equal(grid.mobile, true)
        assert.equal(grid.gap, 8)
        assert.ok(grid.columns >= 2)
        const artworkWidth =
          (grid.cardHeight - 64) / (mediaType === 'album' ? 1 : 1.5)
        assert.ok(
          Math.abs(
            artworkWidth * grid.columns + grid.gap * (grid.columns - 1) - width,
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

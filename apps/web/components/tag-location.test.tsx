import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { tagLevelOrder } from '@repo/schemas/browse'
import {
  TagLocation,
  nextTagLocation,
} from '@repo/ui/components/ds/tag-location'
import { parseTagLevelsParam } from '@/utils/browse-items'
import { TagLocationSection } from './tag-location-section'

const levels = [
  { value: 'track', label: 'Track' },
  { value: 'album', label: 'Album' },
  { value: 'artist', label: 'Artist' },
] as const

/** Each checkbox row's label with whether it is ticked and disabled. */
function rows(markup: string) {
  return [
    ...markup.matchAll(/<label class="ds-checkrow"><input([^>]*)\/>([^<]+)/g),
  ].map(([, attributes = '', label]) => ({
    label,
    checked: attributes.includes('checked=""'),
    disabled: attributes.includes('disabled=""'),
  }))
}

test('Auto is ticked and the levels are disabled and unticked', () => {
  const markup = renderToStaticMarkup(
    <TagLocation
      levels={levels}
      value={undefined}
      defaults={['track']}
      hint="Example hint."
      onChange={() => {}}
    />,
  )
  assert.match(markup, /role="group" aria-label="Tag location"/)
  assert.deepEqual(rows(markup), [
    { label: 'Auto: most detailed', checked: true, disabled: false },
    { label: 'Track', checked: false, disabled: true },
    { label: 'Album', checked: false, disabled: true },
    { label: 'Artist', checked: false, disabled: true },
  ])
  assert.match(markup, /<span class="ds-muted">Example hint\.<\/span>/)
})

test('ticked levels show with Auto unticked', () => {
  const markup = renderToStaticMarkup(
    <TagLocation
      levels={levels}
      value={['track', 'artist']}
      defaults={['track']}
      onChange={() => {}}
    />,
  )
  assert.deepEqual(rows(markup), [
    { label: 'Auto: most detailed', checked: false, disabled: false },
    { label: 'Track', checked: true, disabled: false },
    { label: 'Album', checked: false, disabled: false },
    { label: 'Artist', checked: true, disabled: false },
  ])
  assert.doesNotMatch(markup, /ds-muted/)
})

test('unticking Auto ticks the defaults; ticking it returns to Auto', () => {
  assert.deepEqual(
    nextTagLocation(tagLevelOrder, undefined, { auto: false }, [
      'album',
      'artist',
    ]),
    ['album', 'artist'],
  )
  assert.equal(
    nextTagLocation(tagLevelOrder, ['track'], { auto: true }, ['track']),
    undefined,
  )
})

test('toggling levels keeps the order track, album, artist', () => {
  assert.deepEqual(
    nextTagLocation(tagLevelOrder, ['artist'], { level: 'track', on: true }, [
      'track',
    ]),
    ['track', 'artist'],
  )
  assert.deepEqual(
    nextTagLocation(
      tagLevelOrder,
      ['track', 'artist'],
      { level: 'album', on: true },
      ['track'],
    ),
    ['track', 'album', 'artist'],
  )
  assert.deepEqual(
    nextTagLocation(
      tagLevelOrder,
      ['track', 'album', 'artist'],
      { level: 'album', on: false },
      ['track'],
    ),
    ['track', 'artist'],
  )
})

test('unticking the last level returns to Auto', () => {
  assert.equal(
    nextTagLocation(tagLevelOrder, ['album'], { level: 'album', on: false }, [
      'track',
    ]),
    undefined,
  )
})

test('the Tracks drawer section is closed on Auto and says what Auto reads', () => {
  const markup = renderToStaticMarkup(
    <TagLocationSection
      library="track"
      value={undefined}
      onChange={() => {}}
    />,
  )
  assert.match(markup, /<details class="browse-disclosure">/)
  assert.match(markup, /<span>Tag location<\/span>/)
  assert.match(
    markup,
    /Each track’s own tags; its album’s and artists’ tags for tags that tracks do not carry, or when it has none\./,
  )
})

test('the drawer sections open on a location from the URL', () => {
  const tracks = renderToStaticMarkup(
    <TagLocationSection
      library="track"
      value={parseTagLevelsParam('album,track')}
      onChange={() => {}}
    />,
  )
  assert.match(tracks, /<details class="browse-disclosure" open="">/)
  assert.deepEqual(
    rows(tracks).map((row) => row.checked),
    [false, true, true, false],
  )
  assert.match(tracks, /A track matches when any ticked level has the tag\./)
  const albums = renderToStaticMarkup(
    <TagLocationSection
      library="album"
      value={parseTagLevelsParam('artist')}
      onChange={() => {}}
    />,
  )
  assert.match(albums, /An album matches when any ticked level has the tag\./)
  const auto = renderToStaticMarkup(
    <TagLocationSection
      library="album"
      value={undefined}
      onChange={() => {}}
    />,
  )
  assert.match(
    auto,
    /The album’s tags; its artists’ tags when it has fewer than two\./,
  )
})

test('an absent, empty or unknown tagLevels parameter is Auto', () => {
  assert.equal(parseTagLevelsParam(null), undefined)
  assert.equal(parseTagLevelsParam(''), undefined)
  assert.equal(parseTagLevelsParam('track,label'), undefined)
  assert.deepEqual(parseTagLevelsParam('artist,track'), ['track', 'artist'])
})

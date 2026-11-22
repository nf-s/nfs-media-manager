import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import { TrackBrowseTags } from './track-browse-cells'

const track = TrackListItemSchema.parse({
  id: 'track-1',
  mediaType: 'track',
  title: 'Synthetic track',
  artworkUrl: null,
  releaseDate: null,
  artists: ['Example artist'],
  albumName: 'Example album',
  album: { id: 'album-1', title: 'Example album' },
  albumLinkStrategy: null,
  trackTags: ['Deep Current', 'Electronic'],
  albumTags: ['Electronic', 'Synthetic Wave'],
  artistTags: ['Glass Pop'],
  playlists: [],
  durationSec: null,
  dateAdded: null,
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 0,
  lastListenedAt: null,
})

const pills = (html: string) =>
  [...html.matchAll(/title="([^"]+)"/g)].map((match) => match[1])

test('the Tags cell shows the track’s own tags first, then the album’s, without repeats', () => {
  const html = renderToStaticMarkup(
    <TrackBrowseTags track={track} onFilter={() => undefined} />,
  )
  // TTAG-14: Electronic once, as the track's; Synthetic Wave is counted.
  assert.deepEqual(pills(html), [
    'Track tag: Deep Current',
    'Track tag: Electronic',
    '1 more',
  ])
})

test('the Track tags cell shows only the track’s own tags', () => {
  const filters: unknown[] = []
  const html = renderToStaticMarkup(
    <TrackBrowseTags
      track={track}
      field="trackTag"
      onFilter={(filter) => filters.push(filter)}
      filterHref={(filter) => `/tracks?filters=${JSON.stringify([filter])}`}
    />,
  )
  assert.deepEqual(pills(html), [
    'Track tag: Deep Current',
    'Track tag: Electronic',
  ])
  assert.match(
    html,
    /&quot;field&quot;:&quot;trackTag&quot;,&quot;value&quot;:&quot;Deep Current&quot;/,
  )
})

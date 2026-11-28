import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  albumBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  trackBrowseFields,
} from '@repo/schemas/browse'
import {
  subscriptionBrowseFields,
  mixBrowseFields,
} from '@repo/schemas/subscriptions'
import { BrowseFilterChips } from './browse-controls'
import { ConfigContext } from './providers'
import { libraryPlaylistKey } from '@/utils/library-playlists'

// Only the fields the catalog lookup reads; the rest of a summary is unused.
const catalog = [{ id: 'fixture-ratings', displayName: 'Fixture Ratings' }]

function chips(
  filters: Parameters<typeof BrowseFilterChips>[0]['filters'],
  fields = albumBrowseFields,
  /** Null: the catalog has not loaded. */
  providers: typeof catalog | null = catalog,
) {
  const client = new QueryClient()
  if (providers) client.setQueryData(['providers'], providers)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <BrowseFilterChips
          filters={filters}
          fields={fields}
          onChange={() => {}}
        />
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('a Provider chip names the provider from the catalog, keeping the ID unknown names', () => {
  const html = chips([
    { field: 'provider', value: 'fixture-ratings', mode: 'required' },
    { field: 'provider', value: 'fixture-unlisted' },
  ])
  assert.match(html, /Required · Provider: Fixture Ratings/)
  assert.match(html, /Remove Fixture Ratings filter/)
  assert.match(html, /Any · Provider: fixture-unlisted/)
  assert.doesNotMatch(html, /fixture-ratings</)
})

test('a Provider chip shows the ID until the catalog has loaded', () => {
  assert.match(
    chips(
      [{ field: 'provider', value: 'fixture-ratings' }],
      albumBrowseFields,
      null,
    ),
    /Any · Provider: fixture-ratings/,
  )
})

test('chips for the Edition, Has track tags, Live state and Has recording fields', () => {
  assert.match(
    chips([
      { field: 'edition', value: 'Edition of another album', mode: 'exclude' },
    ]),
    /Excluded · Edition: Edition of another album/,
  )
  assert.match(
    chips([{ field: 'hasTrackTags', value: 'Yes' }], trackBrowseFields),
    /Any · Has track tags: Yes/,
  )
  assert.match(
    chips(
      [{ field: 'live', value: 'Upcoming', mode: 'required' }],
      subscriptionBrowseFields,
    ),
    /Required · Live state: Upcoming/,
  )
  assert.match(
    chips([{ field: 'hasRecording', value: 'No' }], mixBrowseFields),
    /Any · Has recording: No/,
  )
})

function playlistChips(
  filters: Parameters<typeof BrowseFilterChips>[0]['filters'],
  setup: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  setup(client)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <BrowseFilterChips
            filters={filters}
            fields={trackBrowseFields}
            onChange={() => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('a library playlist filter is the chip Playlist: Name, in its mode', () => {
  const html = playlistChips(
    [{ field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'pl-1', mode: 'required' }],
    (client) =>
      client.setQueryData(libraryPlaylistKey('pl-1'), {
        id: 'pl-1',
        library: 'tracks',
        type: 'playlist',
        name: 'Late Shift',
        entryCount: 3,
        view: null,
        updatedAt: '2026-11-28T00:00:00.000Z',
        createdAt: '2026-11-01T00:00:00.000Z',
        repeatCount: 0,
      }),
  )
  assert.match(html, /Required · Playlist: Late Shift/)
  assert.match(html, /title="Cycle Any \/ Required \/ Excluded"/)
  assert.match(html, /aria-label="Remove playlist filter"/)
  assert.doesNotMatch(html, /pl-1|libraryPlaylist/)
})

test('a filter on a deleted playlist reads Playlist: removed', () => {
  const html = playlistChips(
    [{ field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'pl-gone', mode: 'any' }],
    (client) =>
      client
        .getQueryCache()
        .build(client, { queryKey: libraryPlaylistKey('pl-gone') })
        .setState({
          status: 'error',
          error: Object.assign(new Error('Playlist not found'), {
            statusCode: 404,
          }),
        }),
  )
  assert.match(html, /Any · Playlist: removed/)
})

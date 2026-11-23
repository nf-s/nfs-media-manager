import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { albumBrowseFields, trackBrowseFields } from '@repo/schemas/browse'
import {
  subscriptionBrowseFields,
  mixBrowseFields,
} from '@repo/schemas/subscriptions'
import { BrowseFilterChips } from './browse-controls'

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

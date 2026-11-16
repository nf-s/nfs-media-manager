import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MatchCandidate } from '@repo/schemas/find-match'
import {
  FindMatch,
  candidateYear,
  searchFieldValue,
  type FindMatchContext,
} from './find-match'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in Find match rendering tests')
})

const candidate: MatchCandidate = {
  referenceType: 'release',
  externalId: '22',
  title: 'Example Album',
  subtitle: 'Example Artist',
  releaseDate: '2020-05-01',
  artworkUrl: 'https://img.example.test/cover.jpg',
  url: 'https://provider.example.test/release/22',
  current: false,
}

function render(
  stored: MatchCandidate[],
  chooseUnavailable?: string,
  query?: string,
) {
  const client = new QueryClient()
  const context: FindMatchContext = {
    canRefresh: true,
    stored,
    query,
    cancel: () => {},
    chosen: () => {},
  }
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <FindMatch
            scope={{ kind: 'album', id: 'album-1' }}
            provider="example"
            label="Example provider"
            context={context}
            chooseUnavailable={chooseUnavailable}
            onChoose={async () => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('stored candidates list without a request, each with artwork, creator, year, link and Choose', () => {
  const html = render(
    [
      candidate,
      {
        ...candidate,
        externalId: '23',
        title: 'Stored Album',
        subtitle: null,
        releaseDate: null,
        artworkUrl: null,
        url: null,
        current: true,
      },
    ],
    undefined,
    'Example Artist Example Album',
  )
  assert.match(html, />Search Example provider<\/label>/)
  assert.match(html, /value="Example Artist Example Album"/)
  assert.match(html, /aria-label="Example provider candidates"/)
  assert.match(html, /src="https:\/\/img.example.test\/cover.jpg"/)
  assert.match(html, /class="ds-row-by">Example Artist · 2020</)
  assert.match(html, /class="ds-row-by">Current</)
  assert.match(
    html,
    /href="https:\/\/provider.example.test\/release\/22"[^>]*aria-label="Open Example Album on Example provider \(opens in a new tab\)"/,
  )
  assert.match(
    html,
    /<button[^>]*aria-label="Choose Example Album"[^>]*>Choose/,
  )
  assert.match(
    html,
    /disabled=""[^>]*title="Stored now"[^>]*aria-label="Choose Stored Album"/,
  )
  assert.equal(html.match(/>Choose</g)?.length, 2)
})

test('choosing is disabled with the reason when the provider cannot refresh', () => {
  const html = render([candidate], 'Cannot refresh now')
  assert.match(
    html,
    /disabled=""[^>]*title="Cannot refresh now"[^>]*aria-label="Choose Example Album"/,
  )
})

test('years are read from provider dates of any precision', () => {
  assert.equal(candidateYear('2020'), '2020')
  assert.equal(candidateYear('2020-05'), '2020')
  assert.equal(candidateYear('2020-05-01'), '2020')
  assert.equal(candidateYear('Unknown'), null)
  assert.equal(candidateYear(null), null)
})

test('the search field shows the search asked for while it runs or after it fails', () => {
  // Submitted without typing: no result yet for the new query.
  assert.equal(
    searchFieldValue(null, { q: 'Asked' }, undefined, 'Item text'),
    'Asked',
  )
  assert.equal(
    searchFieldValue(null, { q: 'Asked' }, 'Earlier', 'Item text'),
    'Asked',
  )
  assert.equal(
    searchFieldValue('Typed', { q: 'Asked' }, 'Earlier', undefined),
    'Typed',
  )
  // The first search uses the item's own text; the result names the query.
  assert.equal(searchFieldValue(null, {}, 'Derived', 'Item text'), 'Derived')
  assert.equal(searchFieldValue(null, {}, undefined, 'Item text'), 'Item text')
  assert.equal(searchFieldValue(null, null, undefined, undefined), '')
})

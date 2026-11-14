import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AppNavigation from './app-navigation'
import ImportsWorkspace, { ImportStatusNotice } from './imports-workspace'
import { LibrarySelector, MediaScopeContent } from './media-scope'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in navigation tests')
})
const router = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  hmrRefresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: async () => {},
}

function render(path: string, search: string, children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['import-formats'],
    [{ id: 'fixture-csv', label: 'Fixture film CSV', kind: 'csv' }],
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <AppRouterContext.Provider value={router}>
            <PathnameContext.Provider value={path}>
              <SearchParamsContext.Provider value={new URLSearchParams(search)}>
                {children}
              </SearchParamsContext.Provider>
            </PathnameContext.Provider>
          </AppRouterContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Tracks navigation offers only supported destinations without changing library', () => {
  const html = render('/tracks', 'q=fixture', <AppNavigation />)
  assert.match(html, /aria-current="page" href="\/tracks\?q=fixture">Browse/)
  assert.match(html, /href="\/playlists\?mediaType=track">Playlists/)
  assert.match(html, /href="\/imports\?mediaType=track">Imports/)
  assert.doesNotMatch(html, />Tags<|>Jobs<|>Providers<|mediaType=album/)
})

test('shared track import pages retain Tracks in the selector and navigation', () => {
  for (const path of ['/imports/lastfm', '/imports/spotify-playlists']) {
    const html = render(
      path,
      'mediaType=track',
      <>
        <LibrarySelector />
        <AppNavigation />
      </>,
    )
    assert.match(html, /<option value="track" selected="">Tracks<\/option>/)
    assert.match(html, /href="\/tracks">Browse/)
    assert.match(
      html,
      /aria-current="page" href="\/imports\?mediaType=track">Imports/,
    )
    assert.doesNotMatch(html, />Tags<|>Jobs<|>Providers<|mediaType=album/)
  }
})

test('Tracks imports expose Spotify and Last.fm without film or album import controls', () => {
  const html = render(
    '/imports/lastfm',
    'mediaType=track',
    <ImportsWorkspace>
      <ImportStatusNotice />
      <p>Track sync content</p>
    </ImportsWorkspace>,
  )
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=track"/)
  assert.match(
    html,
    /aria-current="page" href="\/imports\/lastfm\?mediaType=track"/,
  )
  assert.match(html, /Last.fm tracks/)
  assert.match(html, /Track sync content/)
  assert.doesNotMatch(
    html,
    /Recent imports|CSV|NFO|Legacy|saved albums|Loading imports/,
  )
})

test('invalid track-scoped metadata destinations never mount another library’s content', () => {
  for (const path of ['/tags', '/jobs', '/providers', '/imports/csv']) {
    const html = render(
      path,
      'mediaType=track',
      <MediaScopeContent>
        <p>Wrong library content</p>
      </MediaScopeContent>,
    )
    assert.equal(html, '')
  }
})

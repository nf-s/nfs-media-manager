import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LibraryPlaylistSummarySchema } from '@repo/schemas/library-playlists'
import {
  ItemPlaylistsSection,
  LibraryPlaylistMembershipRows,
  membershipLine,
  useItemAddToPlaylist,
} from './item-playlists'
import { ConfigContext } from './providers'
import { libraryPlaylistMembershipsKey } from '@/utils/library-playlists'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const lateShift = LibraryPlaylistSummarySchema.parse({
  id: 'lp-1',
  library: 'tracks',
  type: 'playlist',
  name: 'Late Shift',
  entryCount: 18,
  view: null,
  updatedAt: '2026-11-28T00:00:00.000Z',
})

function render(children: ReactNode, data: Array<[unknown[], unknown]> = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const [key, value] of data) client.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          {children}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function Header() {
  const add = useItemAddToPlaylist('tracks', {
    id: 'track-1',
    title: 'Harbour Lights',
  })
  return (
    <>
      {add.action}
      <output>{add.menuItem.label}</output>
    </>
  )
}

test('the header has Add to playlist with the playlist icon and a chevron, opening the picker', () => {
  const html = render(<Header />)
  assert.match(
    html,
    /<button class="ds-btn" data-size="md" popoverTarget="([^"]+)" aria-haspopup="dialog" aria-expanded="false" aria-controls="\1"><svg[^>]*lucide-list-music[^>]*>[\s\S]*?<\/svg>Add to playlist<svg[^>]*lucide-chevron-down/,
  )
  assert.match(html, /<output>Add to playlist…<\/output>/)
})

test('each playlist that holds the item opens it and reads Library and its count', () => {
  assert.equal(membershipLine(lateShift), 'Library · 18 tracks')
  assert.equal(
    membershipLine({ ...lateShift, library: 'albums', entryCount: 1 }),
    'Library · 1 album',
  )
  const html = render(<LibraryPlaylistMembershipRows playlists={[lateShift]} />)
  assert.match(
    html,
    /<a class="ds-row-title" href="\/playlists\/library\/lp-1">Late Shift<\/a><span class="ds-row-by">Library · 18 tracks<\/span>/,
  )
})

test('details without imported playlists list them under Playlists, or In no playlist', () => {
  const key = libraryPlaylistMembershipsKey('films', 'film-1')
  const listed = render(
    <ItemPlaylistsSection library="films" itemId="film-1" />,
    [
      [
        key,
        [
          {
            ...lateShift,
            library: 'films',
            name: 'Double Bills',
            entryCount: 6,
          },
        ],
      ],
    ],
  )
  assert.match(listed, /<h3>Playlists<\/h3>/)
  assert.match(listed, />Double Bills<\/a>/)
  assert.match(listed, /Library · 6 films/)
  const empty = render(
    <ItemPlaylistsSection library="films" itemId="film-1" />,
    [[key, []]],
  )
  assert.match(
    empty,
    /<h3>Playlists<\/h3><\/div><div class="ds-state" data-size="sm" role="status"><strong>In no playlist<\/strong><\/div>/,
  )
})

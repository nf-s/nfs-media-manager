import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AlbumTitle from './album-title'
import ServiceIconLinks from './service-icon-links'
import DetailProviderLinks from './detail-provider-links'
import { albumSpotifyDestination } from '../utils/album-links'

const album = {
  title: 'Fixture album',
  spotifyUrl: 'https://open.spotify.com/album/1234567890ABCDEFGHIJKL',
  providerReferences: [],
  links: [
    {
      provider: 'search',
      label: 'Spotify result',
      url: 'https://open.spotify.com/album/1234567890ABCDEFGHIJKL',
    },
    {
      provider: 'lastfm',
      label: 'Last.fm',
      url: 'https://www.last.fm/music/Fixture/Album',
    },
  ],
}

test('a Spotify-linked album title has no duplicate Spotify service affordance', () => {
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={album} onOpenDetails={() => {}} />
      <ServiceIconLinks
        links={album.links}
        hideSpotify={Boolean(albumSpotifyDestination(album))}
      />
    </>,
  )
  assert.equal(
    (html.match(/href="https:\/\/open.spotify.com/g) ?? []).length,
    1,
  )
  assert.match(html, /Fixture album on Spotify \(opens in a new tab\)/)
  assert.match(html, /Open Last.fm/)
})

test('detail service links still include Spotify by default', () => {
  const html = renderToStaticMarkup(<ServiceIconLinks links={album.links} />)
  assert.match(html, /Open Spotify/)
  assert.match(html, /Open Last.fm/)
})

test('detail header suppresses only Spotify when its album title already links there', () => {
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={album} />
      <DetailProviderLinks
        fields={[]}
        values={{}}
        links={album.links}
        spotifyUrl={album.spotifyUrl}
        hideSpotify={Boolean(albumSpotifyDestination(album))}
      />
    </>,
  )
  assert.equal(
    (html.match(/href="https:\/\/open.spotify.com/g) ?? []).length,
    1,
  )
  assert.match(html, /Fixture album on Spotify/)
  assert.match(html, /Open Last.fm/)
})

test('a non-album Spotify link retains its icon and local title navigation', () => {
  const item = {
    ...album,
    spotifyUrl: null,
    links: [
      {
        provider: 'spotify',
        label: 'Spotify',
        url: 'https://open.spotify.com/artist/1234567890ABCDEFGHIJKL',
      },
    ],
  }
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={item} onOpenDetails={() => {}} />
      <ServiceIconLinks
        links={item.links}
        hideSpotify={Boolean(albumSpotifyDestination(item))}
      />
    </>,
  )
  assert.match(html, /<button/)
  assert.match(html, /Open details for Fixture album/)
  assert.match(html, /Open Spotify/)
})

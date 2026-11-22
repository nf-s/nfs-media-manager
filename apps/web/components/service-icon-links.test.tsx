import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AlbumTitle from './album-title'
import ServiceIconLinks, {
  AlbumSpotifyLink,
  serviceLinks,
} from './service-icon-links'
import DetailProviderLinks from './detail-provider-links'
import { albumBrowseFields, filmBrowseFields } from '@repo/schemas/browse'
import { albumSpotifyDestination } from '../utils/album-links'
import { providerLogoUrl } from '../utils/provider-logos'

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

test('an album has one compact Spotify service link beside its local title', () => {
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={album} onOpenDetails={() => {}} />
      <AlbumSpotifyLink item={album} />
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
  assert.match(html, /Open details for Fixture album/)
  assert.match(html, /Open Spotify \(opens in a new tab\)/)
  assert.match(html, /Open Last.fm/)
})

test('detail service links still include Spotify by default', () => {
  const html = renderToStaticMarkup(<ServiceIconLinks links={album.links} />)
  assert.match(html, /Open Spotify/)
  assert.match(html, /Open Last.fm/)
})

test('the provider group displays rated and unrated services together and omits the title Spotify icon', () => {
  const links = [
    ...album.links,
    {
      provider: 'rym',
      label: 'RYM',
      url: 'https://rateyourmusic.com/release/album/example/record/',
    },
  ]
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={album} />
      <AlbumSpotifyLink item={album} />
      <DetailProviderLinks
        fields={albumBrowseFields}
        values={{ ratingRymValue: 3.65 }}
        links={links}
        spotifyUrl={album.spotifyUrl}
        hideSpotify={Boolean(albumSpotifyDestination(album))}
      />
    </>,
  )
  assert.equal(
    (html.match(/href="https:\/\/open.spotify.com/g) ?? []).length,
    1,
  )
  assert.match(
    html,
    /class="ds-ratings"[^>]*aria-label="Provider ratings and links"[^>]*>.*RYM rating: 3\.65.*Open Last.fm/,
  )
  assert.equal(
    (html.match(/href="https:\/\/rateyourmusic.com/g) ?? []).length,
    1,
  )
})

test('compact provider groups preserve links for providers whose rating is only shown in details', () => {
  const html = renderToStaticMarkup(
    <DetailProviderLinks
      fields={filmBrowseFields}
      values={{ ratingTmdb: 7.4 }}
      links={[
        {
          provider: 'tmdb',
          label: 'TMDb',
          url: 'https://www.themoviedb.org/movie/1234',
        },
      ]}
      context="table"
    />,
  )
  assert.match(html, /aria-label="Open TMDb \(opens in a new tab\)"/)
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

test('a TIDAL link is named TIDAL and drawn with the TIDAL mark', () => {
  const tidal = 'https://tidal.com/browse/album/100001'
  assert.equal(providerLogoUrl('tidal'), '/icons/logos/tidal.svg')
  assert.deepEqual(
    serviceLinks([{ provider: 'fixture', label: 'Fixture', url: tidal }]),
    [{ provider: 'tidal', label: 'TIDAL', url: tidal }],
  )
  const html = renderToStaticMarkup(
    <ServiceIconLinks
      links={[{ provider: 'tidal', label: 'TIDAL', url: tidal }]}
    />,
  )
  assert.match(html, /aria-label="Open TIDAL \(opens in a new tab\)"/)
  assert.match(html, /--ds-logo:url\(&quot;\/icons\/logos\/tidal\.svg&quot;\)/)
})

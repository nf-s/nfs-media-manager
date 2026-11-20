import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AlbumTitle from './album-title'
import ServiceIconLinks, { AlbumSpotifyLink } from './service-icon-links'

const item = {
  title: 'Test album',
  spotifyUrl: 'https://open.spotify.com/album/1234567890ABCDEFGHIJKL',
  links: [],
  providerReferences: [],
}

test('album titles open local details and Spotify has a separate compact link', () => {
  const html = renderToStaticMarkup(
    <>
      <AlbumTitle item={item} className="tile-title" onOpenDetails={() => {}} />
      <AlbumSpotifyLink item={item} />
    </>,
  )
  assert.match(
    html,
    /<button type="button" class="tile-title"[^>]*>Test album<\/button>/,
  )
  assert.match(html, /href="https:\/\/open.spotify.com\/album\//)
  assert.match(html, /aria-label="Open Spotify \(opens in a new tab\)"/)
  // The compact logo: the Spotify logo's shape in the muted ink, at 14px.
  assert.match(
    html,
    /<span class="ds-logo" data-size="sm" style="--ds-logo:url\(&quot;\/icons\/services\/spotify.svg&quot;\)" aria-hidden="true"><\/span>/,
  )
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('missing or unsafe Spotify destinations omit the outbound icon', () => {
  for (const spotifyUrl of [
    null,
    'https://evil.test/album/1234567890ABCDEFGHIJKL',
  ]) {
    const html = renderToStaticMarkup(
      <AlbumSpotifyLink item={{ ...item, spotifyUrl }} />,
    )
    assert.equal(html, '')
  }
  assert.equal(renderToStaticMarkup(<AlbumTitle item={item} />), 'Test album')
})

test('service links use local logos, accessible names and safe separate-tab anchors', () => {
  const html = renderToStaticMarkup(
    <ServiceIconLinks
      links={[
        { provider: 'spotify', label: 'Spotify', url: item.spotifyUrl },
        {
          provider: 'lastfm',
          label: 'lastfm',
          url: 'https://www.last.fm/music/Test/Album',
        },
        {
          provider: 'musicbrainz',
          label: 'musicbrainz',
          url: 'https://musicbrainz.org/release/test',
        },
        { provider: 'other', label: 'Other', url: 'javascript:alert(1)' },
      ]}
    />,
  )
  assert.equal((html.match(/<a /g) ?? []).length, 3)
  // Each logo is drawn from its local file's shape, in one grey.
  for (const logo of [
    '/icons/services/spotify.svg',
    '/icons/logos/lastfm.png',
    '/img/mb.png',
  ])
    assert.ok(html.includes(`--ds-logo:url(&quot;${logo}&quot;)`))
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /lucide-radio|lucide-audio-lines|lucide-disc-3/)
  for (const label of ['Spotify', 'Last.fm', 'MusicBrainz'])
    assert.ok(html.includes(`aria-label="Open ${label} (opens in a new tab)"`))
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 3)
  assert.equal((html.match(/title="Open /g) ?? []).length, 3)
  assert.doesNotMatch(html, /javascript:|<button|<iframe/)
})

test('service identity follows hostname rather than a shared search adapter', () => {
  const html = renderToStaticMarkup(
    <ServiceIconLinks
      links={[
        {
          provider: 'google-custom-search',
          label: 'Search result',
          url: 'https://rateyourmusic.com/release/album/test/record/',
        },
        {
          provider: 'google-custom-search',
          label: 'Search result',
          url: 'https://www.metacritic.com/music/record/test/',
        },
        {
          provider: 'google-custom-search',
          label: 'Duplicate RYM',
          url: 'https://rateyourmusic.com/release/album/test/record/',
        },
      ]}
    />,
  )
  assert.equal((html.match(/<a /g) ?? []).length, 2)
  assert.match(html, /aria-label="Open RYM/)
  assert.match(html, /aria-label="Open Metacritic/)
  assert.match(html, /url\(&quot;\/icons\/logos\/rym.png&quot;\)/)
  assert.match(html, /url\(&quot;\/icons\/ratings\/metacritic.svg&quot;\)/)
})

test('unrecognized hosts do not inherit another site identity or collapse by adapter', () => {
  const html = renderToStaticMarkup(
    <ServiceIconLinks
      links={[
        {
          provider: 'google-custom-search',
          label: 'First source',
          url: 'https://rateyourmusic.com.evil.test/album',
        },
        {
          provider: 'google-custom-search',
          label: 'Second source',
          url: 'https://other.example/album',
        },
      ]}
    />,
  )
  assert.equal((html.match(/<a /g) ?? []).length, 2)
  assert.doesNotMatch(html, /rym.png|aria-label="Open RYM/)
})

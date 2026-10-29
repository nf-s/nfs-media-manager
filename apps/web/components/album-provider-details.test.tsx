import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlbumProviderDetailsSchema } from '@repo/schemas/album-provider-details'
import AlbumProviderDetails from './album-provider-details'

test('omits empty provider details and keeps long information collapsed', () => {
  assert.equal(renderToStaticMarkup(<AlbumProviderDetails details={[]} />), '')
  const source = AlbumProviderDetailsSchema.parse({
    provider: 'musicbrainz',
    url: 'https://musicbrainz.org/release-group/example',
    facts: [{ label: 'Release type', value: 'Album' }],
    notes: [{ label: 'Disambiguation', text: 'Original release' }],
    credits: [{ name: 'Example Artist', role: 'Producer' }],
    tags: [{ name: 'piano', kind: 'general', count: 0, countLabel: 'votes' }],
    tracks: [
      {
        title: 'First track',
        position: 'A1',
        url: 'https://www.last.fm/music/example/_/first',
      },
    ],
  })
  const html = renderToStaticMarkup(<AlbumProviderDetails details={[source]} />)
  assert.match(html, /More album info/)
  assert.match(html, /Release type/)
  assert.match(html, /Credits \(1\)/)
  assert.match(html, /piano.*0.*votes/)
  assert.match(html, /A1/)
  assert.match(html, /target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /<details[^>]* open/)
})

test('renders retained provider prose as text, never executable markup', () => {
  const source = AlbumProviderDetailsSchema.parse({
    provider: 'lastfm',
    notes: [{ label: 'Notes', text: '<script>alert(1)</script>' }],
  })
  const html = renderToStaticMarkup(<AlbumProviderDetails details={[source]} />)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})

test('shared provider details reject executable and credential-bearing URLs', () => {
  for (const url of [
    'not a URL',
    'javascript:alert(1)',
    'file:///tmp/album',
    'https://user:secret@example.com',
  ]) {
    assert.equal(
      AlbumProviderDetailsSchema.safeParse({
        provider: 'discogs',
        links: [{ label: 'Source', url }],
      }).success,
      false,
    )
  }
})

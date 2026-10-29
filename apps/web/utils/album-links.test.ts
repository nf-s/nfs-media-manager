import assert from 'node:assert/strict'
import { test } from 'node:test'
import { albumSpotifyDestination, spotifyAlbumUrl } from './album-links'

const id = '1234567890ABCDEFGHIJKL'
const url = `https://open.spotify.com/album/${id}`
const reference = {
  provider: 'spotify',
  referenceType: 'spotify',
  isPrimary: true,
  metadata: null,
}

test('accepts only HTTPS Spotify album destinations and removes tracking', () => {
  for (const input of [
    url,
    `${url}/?si=tracking`,
    `https://open.spotify.com/intl-en/album/${id}`,
  ])
    assert.equal(spotifyAlbumUrl(input), url)
  for (const input of [
    null,
    '',
    'javascript:alert(1)',
    `http://open.spotify.com/album/${id}`,
    `https://open.spotify.com.evil.test/album/${id}`,
    `https://user@open.spotify.com/album/${id}`,
    `https://open.spotify.com:444/album/${id}`,
    `https://open.spotify.com/track/${id}`,
    `https://open.spotify.com/album/short`,
    `https://open.spotify.com/album/${id}/extra`,
  ])
    assert.equal(spotifyAlbumUrl(input), undefined)
})

test('uses stored URLs then explicitly typed Spotify album references without guessing', () => {
  const item = { spotifyUrl: null, links: [], providerReferences: [] }
  assert.equal(albumSpotifyDestination(item), undefined)
  assert.equal(albumSpotifyDestination({ ...item, spotifyUrl: url }), url)
  assert.equal(
    albumSpotifyDestination({
      ...item,
      links: [{ provider: 'spotify', label: 'Spotify', url }],
    }),
    url,
  )
  for (const externalId of [id, `spotify:album:${id}`, url])
    assert.equal(
      albumSpotifyDestination({
        ...item,
        providerReferences: [{ ...reference, externalId }],
      }),
      url,
    )
  for (const externalId of ['album title', `spotify:track:${id}`])
    assert.equal(
      albumSpotifyDestination({
        ...item,
        providerReferences: [{ ...reference, externalId }],
      }),
      undefined,
    )
  assert.equal(
    albumSpotifyDestination({
      ...item,
      providerReferences: [
        { ...reference, referenceType: 'artist', externalId: id },
      ],
    }),
    undefined,
  )
})

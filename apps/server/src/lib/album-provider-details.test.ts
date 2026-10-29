import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlbumProviderDetailsSchema } from '@repo/schemas/album-provider-details'
import {
  albumProviderDetailsMetadata,
  readAlbumProviderDetails,
} from './album-provider-details'

const mbid = '11111111-1111-4111-8111-111111111111'
const group = {
  id: mbid,
  title: 'Provider title',
  'artist-credit': [
    { artist: { id: mbid, name: 'Provider artist', country: 'GB' } },
  ],
  'primary-type': 'Album',
  'secondary-types': ['Live'],
  'first-release-date': '2001',
  disambiguation: 'Festival recording',
  genres: [{ id: mbid, name: 'Ambient', count: 0 }],
  tags: [{ name: 'Dreamy', count: -1 }, { name: 'Rare' }],
  relations: [
    {
      type: 'official homepage',
      url: { resource: 'https://example.test/album' },
    },
    { type: 'other relationship' },
  ],
}
const release = {
  id: 22,
  title: 'Release title',
  artists: [{ id: 10, name: 'Provider artist' }],
  country: 'AU',
  released: '2001-02-00',
  year: 2001,
  notes: 'Release-specific notes',
  genres: ['Electronic'],
  styles: ['Ambient'],
  labels: [{ id: 1, name: 'Example label', catno: 'CAT-001' }],
  formats: [
    { name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'], text: 'Blue' },
  ],
  companies: [
    {
      id: 2,
      name: 'Example company',
      entity_type_name: 'Pressed By',
      catno: 'PRESS-1',
    },
  ],
  extraartists: [
    { id: 3, name: 'Example producer', role: 'Producer', tracks: 'A1, B1' },
  ],
  tracklist: [
    { type_: 'heading', title: 'Side A', position: '', duration: '' },
    {
      type_: 'track',
      title: 'First',
      position: 'A1',
      duration: '3:01',
      extraartists: [{ name: 'Example mixer', role: 'Mixed By' }],
    },
    { type_: 'track', title: 'Second', position: 'B1', duration: '0:00' },
  ],
  community: { have: 0, want: 15 },
}
const lastfm = {
  name: 'Provider title',
  artist: 'Provider artist',
  url: 'https://www.last.fm/music/Artist/Album',
  tags: '',
  toptags: {
    tag: [
      { name: 'Ambient', count: '0', url: 'https://www.last.fm/tag/ambient' },
    ],
  },
  wiki: {
    summary: 'A summary <a href="https://example.test">source</a>',
    content: 'Longer notes',
    published: '1 Jan 2001, 00:00',
  },
  tracks: {
    track: [
      {
        name: 'First',
        duration: null,
        url: 'https://www.last.fm/music/Artist/_/First',
      },
      { name: 'Second', duration: '0' },
    ],
  },
}

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No live requests allowed')
    }),
  ),
)
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('readonly album provider details', () => {
  it('projects MusicBrainz types, provenance, votes and safe URL relations', () => {
    const payload = { releaseGroup: group }
    const before = structuredClone(payload)
    const result = readAlbumProviderDetails('musicbrainz', payload)
    expect(AlbumProviderDetailsSchema.safeParse(result).success).toBe(true)
    expect(result?.facts).toEqual(
      expect.arrayContaining([
        { label: 'Primary type', value: 'Album' },
        { label: 'Secondary types', value: 'Live' },
        { label: 'Artist countries', value: 'GB' },
        { label: 'First release date', value: '2001' },
      ]),
    )
    expect(result?.notes).toEqual([
      { label: 'Disambiguation', text: 'Festival recording' },
    ])
    expect(result?.tags).toEqual([
      { name: 'Ambient', kind: 'genre', count: 0, countLabel: 'votes' },
      { name: 'Dreamy', kind: 'tag', count: -1, countLabel: 'votes' },
      { name: 'Rare', kind: 'tag' },
    ])
    expect(result?.links).toEqual([
      { label: 'official homepage', url: 'https://example.test/album' },
    ])
    expect(payload).toEqual(before)
    expect(readAlbumProviderDetails('musicbrainz', group)).toEqual(result)
    const metadata = albumProviderDetailsMetadata('musicbrainz', payload)
    expect(metadata['plugin.musicbrainz.details']).toEqual(result)
    expect(metadata['plugin.musicbrainz.tagEvidence']).toContainEqual({
      name: 'Ambient',
      rawName: 'Ambient',
      source: 'musicbrainz',
      sourceKind: 'genre',
      count: 0,
      sourceId: mbid,
      url: null,
    })
    expect(metadata.browse).toEqual({
      'plugin.musicbrainz.primaryType': 'Album',
      'plugin.musicbrainz.secondaryTypes': ['Live'],
      'plugin.musicbrainz.artistCountries': ['GB'],
    })
  })

  it('uses only main-release edition details and preserves native positions', () => {
    const payload = {
      master: {
        ...release,
        id: 11,
        main_release: 22,
        notes: 'Wrong master notes',
        country: 'US',
      },
      mainRelease: { ...release, master_id: 11 },
    }
    const before = structuredClone(payload)
    const result = readAlbumProviderDetails('discogs', payload)
    expect(result?.url).toBe('https://www.discogs.com/master/11')
    expect(result?.facts).toEqual(
      expect.arrayContaining([
        { label: 'Edition scope', value: 'Main release 22 only' },
        { label: 'Release country', value: 'AU' },
        { label: 'Have (release)', value: '0' },
        { label: 'Want (release)', value: '15' },
        { label: 'Label', value: 'Example label / CAT-001' },
        { label: 'Format', value: '2 x / Vinyl / LP / Album / Blue' },
        { label: 'Pressed By', value: 'Example company / PRESS-1' },
      ]),
    )
    expect(result?.notes).toEqual([
      { label: 'Release notes', text: 'Release-specific notes' },
    ])
    expect(result?.credits).toEqual([
      { name: 'Example producer', role: 'Producer (A1, B1)' },
      { name: 'Example mixer', role: 'Mixed By (A1)' },
    ])
    expect(result?.tracks).toEqual([
      { title: 'Side A', position: '' },
      { title: 'First', position: 'A1' },
      { title: 'Second', position: 'B1' },
    ])
    expect(payload).toEqual(before)
    expect(albumProviderDetailsMetadata('discogs', payload).browse).toEqual({
      'plugin.discogs.labels': ['Example label'],
      'plugin.discogs.formats': ['Vinyl, LP, Album'],
      'plugin.discogs.releaseCountry': 'AU',
      'plugin.discogs.have': 0,
      'plugin.discogs.want': 15,
    })
  })

  it('supports a release wrapper and an unwrapped release without inventing a master', () => {
    const result = readAlbumProviderDetails('discogs', { release })
    expect(readAlbumProviderDetails('discogs', release)).toEqual(result)
    expect(result?.url).toBe('https://www.discogs.com/release/22')
  })

  it('keeps missing have/want unknown independently and does not invent zero values', () => {
    const payload = { release: { ...release, community: { have: 0 }, year: 0 } }
    const result = readAlbumProviderDetails('discogs', payload)
    expect(result?.facts).toContainEqual({
      label: 'Have (release)',
      value: '0',
    })
    expect(
      result?.facts.some(
        (fact) =>
          fact.label === 'Want (release)' || fact.label === 'Release year',
      ),
    ).toBe(false)
    expect(
      albumProviderDetailsMetadata('discogs', payload).browse,
    ).not.toHaveProperty('plugin.discogs.want')
  })

  it('retains Last.fm wiki text, top-tag weights/links, track links, empty tags and null durations', () => {
    const payload = { album: lastfm }
    const before = structuredClone(payload)
    const result = readAlbumProviderDetails('lastfm', payload)
    expect(result?.url).toBe(lastfm.url)
    expect(result?.facts).toContainEqual({
      label: 'Wiki published',
      value: '1 Jan 2001, 00:00',
    })
    expect(result?.notes).toEqual([
      { label: 'Wiki summary', text: lastfm.wiki.summary },
      { label: 'Wiki content', text: 'Longer notes' },
    ])
    expect(result?.tags).toEqual([
      { name: 'Ambient', kind: 'toptag', count: 0, countLabel: 'tag count' },
    ])
    expect(result?.links).toEqual([
      { label: 'toptag: Ambient', url: 'https://www.last.fm/tag/ambient' },
    ])
    expect(result?.tracks).toEqual([
      {
        title: 'First',
        position: '1',
        url: 'https://www.last.fm/music/Artist/_/First',
      },
      { title: 'Second', position: '2' },
    ])
    expect(readAlbumProviderDetails('lastfm', lastfm)).toEqual(result)
    expect(
      albumProviderDetailsMetadata('lastfm', payload)['plugin.lastfm.details'],
    ).toEqual(result)
    expect(payload).toEqual(before)
  })

  it.each([
    { provider: 'unknown', payload: { album: lastfm } },
    { provider: 'lastfm', payload: null },
    { provider: 'lastfm', payload: { album: { ...lastfm, tags: 'invalid' } } },
    {
      provider: 'lastfm',
      payload: {
        album: {
          ...lastfm,
          toptags: { tag: [{ name: 'Ambient', count: '-1' }] },
        },
      },
    },
    {
      provider: 'lastfm',
      payload: {
        album: {
          ...lastfm,
          tracks: { track: [{ name: 'First', url: 'javascript:alert(1)' }] },
        },
      },
    },
    {
      provider: 'musicbrainz',
      payload: {
        releaseGroup: {
          ...group,
          relations: [
            {
              type: 'homepage',
              url: { resource: 'https://user:password@example.test' },
            },
          ],
        },
      },
    },
    {
      provider: 'discogs',
      payload: {
        master: { ...release, id: 11, main_release: 33 },
        mainRelease: release,
      },
    },
    {
      provider: 'discogs',
      payload: {
        master: { ...release, id: 11, main_release: 22 },
        mainRelease: { ...release, master_id: 99 },
      },
    },
    {
      provider: 'discogs',
      payload: { master: { ...release, id: 11, main_release: 22 } },
    },
    {
      provider: 'discogs',
      payload: {
        release: {
          ...release,
          formats: [{ name: 'Vinyl', qty: 'not a count' }],
        },
      },
    },
    {
      provider: 'discogs',
      payload: { release: { ...release, community: { have: -1 } } },
    },
  ])(
    'omits unsupported or malformed stored evidence: $provider $payload',
    ({ provider, payload }) => {
      expect(readAlbumProviderDetails(provider, payload)).toBeNull()
      expect(albumProviderDetailsMetadata(provider, payload)).toEqual({
        browse: {},
      })
    },
  )
})

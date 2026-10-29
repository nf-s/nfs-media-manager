import { describe, expect, it, vi } from 'vitest'
import {
  BackfillMembershipSchema,
  BackfillOccurrenceSchema,
  BackfillSnapshotSchema,
  planTagProvenanceBackfill,
  snapshotTagEvidence,
} from './tag-provenance-backfill'

const membership = BackfillMembershipSchema.parse({
  mediaItemId: 'album-a',
  mediaType: 'album',
  tagId: 'arena',
  name: 'arena rock',
  kind: 'genre',
})
const unknown = BackfillOccurrenceSchema.parse({
  id: 'legacy',
  mediaItemId: 'album-a',
  tagId: 'arena',
  provider: null,
  source: null,
  sourceId: null,
  rawName: 'arena rock',
  kind: 'genre',
})
function snapshot(
  provider: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) {
  return BackfillSnapshotSchema.parse({
    id: provider,
    mediaItemId: 'album-a',
    mediaType: 'album',
    provider,
    payload,
    normalizedData: {},
    checksum: provider,
    source: 'legacy-import',
    ...overrides,
  })
}
const musicbrainz = snapshot('musicbrainz', {
  releaseGroup: {
    genres: [
      {
        id: '26af3760-750a-4b5e-a699-78c87697585a',
        name: 'arena rock',
        count: 1,
      },
    ],
    tags: [{ name: 'arena rock' }],
  },
})
const discogs = snapshot('discogs', {
  master: { genres: ['Rock'], styles: ['Arena Rock'] },
})
function plan(snapshots = [musicbrainz, discogs], occurrences = [unknown]) {
  return planTagProvenanceBackfill({
    memberships: [membership],
    occurrences,
    snapshots,
    links: [
      {
        mediaItemId: 'album-a',
        provider: 'musicbrainz',
        url: 'https://musicbrainz.org/release-group/0663bcbd-e202-4aeb-b003-6d49f0a4d152',
      },
      {
        mediaItemId: 'album-a',
        provider: 'discogs',
        url: 'https://www.discogs.com/master/1860333',
      },
    ],
  })
}

describe('snapshot tag provenance backfill', () => {
  it('reproduces Arena Rock from raw snapshots with empty normalized data and derives saved links', () => {
    const result = plan()
    expect(result.additions).toHaveLength(2)
    expect(result.unresolved).toEqual([])
    expect(result.additions[0]).toMatchObject({
      occurrence: {
        provider: 'musicbrainz',
        sourceId: '26af3760-750a-4b5e-a699-78c87697585a',
        kind: 'genre',
      },
      evidence: [
        {
          snapshotId: 'musicbrainz',
          path: 'payload.releaseGroup.genres[0]',
          raw: { name: 'arena rock', count: 1 },
        },
      ],
      link: {
        provider: 'musicbrainz',
        url: 'https://musicbrainz.org/tag/arena%20rock',
      },
    })
    expect(result.additions[1]).toMatchObject({
      occurrence: { provider: 'discogs', rawName: 'Arena Rock' },
      evidence: [{ path: 'payload.master.styles[0]', raw: 'Arena Rock' }],
      link: { provider: 'discogs' },
    })
  })
  it('is additive, deduplicates nested snapshots and remains idempotent', () => {
    const before = structuredClone(unknown)
    const nested = snapshot('legacy-record', {
      mb: musicbrainz.payload,
      discogs: discogs.payload,
    })
    const first = plan([
      musicbrainz,
      discogs,
      nested,
      { ...musicbrainz, id: 'duplicate' },
    ])
    expect(first.additions).toHaveLength(2)
    expect(first.additions[0]?.evidence).toHaveLength(3)
    const second = plan(
      [musicbrainz, discogs, nested],
      [unknown, ...first.additions.map((row) => row.occurrence)],
    )
    expect(second.additions).toEqual([])
    expect(second.alreadyPresent).toBe(2)
    expect(unknown).toEqual(before)
  })
  it('never uses another item, another medium, another kind, fuzzy names or prose', () => {
    const snapshots = [
      { ...musicbrainz, mediaItemId: 'unrelated' },
      snapshot('musicbrainz', musicbrainz.payload, { mediaType: 'film' }),
      snapshot('musicbrainz', {
        tags: [{ name: 'arena rock' }],
        genres: [{ name: 'arena-rock' }],
      }),
      snapshot('lastfm', {
        wiki: { content: 'arena rock' },
        tags: { tag: [{ name: 'rock' }] },
      }),
      snapshot('google-custom-search', { snippet: 'arena rock' }),
      snapshot(
        'legacy-browser',
        { genre: ['arena rock'] },
        { normalizedData: { tags: [{ name: 'arena rock', kind: 'genre' }] } },
      ),
    ]
    expect(plan(snapshots)).toMatchObject({
      additions: [],
      unresolved: [{ reason: 'No exact structured snapshot evidence' }],
    })
  })
  it('matches Unicode and whitespace exactly and follows the original name after a merge', () => {
    const result = planTagProvenanceBackfill({
      memberships: [{ ...membership, name: 'Rock music' }],
      occurrences: [{ ...unknown, rawName: ' ARENA\u00a0ROCK ' }],
      snapshots: [musicbrainz],
    })
    expect(result.additions).toHaveLength(1)
    expect(result.additions[0]?.occurrence.tagId).toBe('arena')
  })
  it('leaves conflicting snapshot IDs unresolved and existing sources untouched', () => {
    const conflict = snapshot(
      'musicbrainz',
      {
        releaseGroup: {
          genres: [
            { name: 'arena rock', id: '17b58d38-1110-4f5a-9412-b0314329622b' },
          ],
        },
      },
      { id: 'conflict' },
    )
    expect(plan([musicbrainz, conflict])).toMatchObject({
      additions: [],
      unresolved: [{ reason: 'Conflicting snapshot source IDs' }],
    })
    const existing = {
      ...unknown,
      id: 'valid',
      provider: 'musicbrainz',
      source: 'musicbrainz',
      sourceId: 'existing-valid-id',
    }
    expect(plan([musicbrainz], [unknown, existing])).toMatchObject({
      additions: [],
      unresolved: [
        { reason: 'Existing source ID differs; preserved unchanged' },
      ],
    })
    expect(existing.sourceId).toBe('existing-valid-id')
  })
  it('does not clear or upgrade an existing attributed occurrence without an unknown origin', () => {
    expect(
      plan([musicbrainz], [{ ...unknown, provider: 'musicbrainz' }]).additions,
    ).toEqual([])
  })
  it('recovers memberships with no occurrences and rejects malformed boundary data', () => {
    expect(plan([discogs], []).additions).toHaveLength(1)
    expect(
      plan([
        snapshot('discogs', { master: { styles: [null, {}, 2, { name: 2 }] } }),
      ]).additions,
    ).toEqual([])
    expect(
      BackfillSnapshotSchema.safeParse({ ...musicbrainz, mediaType: 'tv' })
        .success,
    ).toBe(false)
  })
  it('reads legacy Spotify album genres but never infers album tags from artist genres', () => {
    const legacy = snapshot('spotify', {
      spotify: { genres: ['arena rock'], artists: [{ genres: ['country'] }] },
    })
    expect(plan([legacy]).additions[0]?.evidence[0]?.path).toBe(
      'payload.spotify.genres[0]',
    )
    expect(
      snapshotTagEvidence(
        snapshot('spotify', { artists: [{ genres: ['arena rock'] }] }),
      ),
    ).toEqual([])
  })
  it('recovers retained RYM genre arrays in the historical Google provider namespace', () => {
    const rymGoogle = { genres: ['Arena Rock'] }
    const snapshots = [
      snapshot('google-custom-search', { rymGoogle }),
      snapshot('legacy-record', { rymGoogle }),
    ]
    const result = plan(snapshots)
    expect(result.unresolved).toEqual([])
    expect(result.additions).toHaveLength(1)
    expect(result.additions[0]).toMatchObject({
      occurrence: {
        provider: 'google-custom-search',
        source: 'google-custom-search',
        sourceId: null,
        kind: 'genre',
        rawName: 'Arena Rock',
      },
      evidence: snapshots.map((item) => ({
        snapshotId: item.id,
        checksum: item.checksum,
        path: 'payload.rymGoogle.genres[0]',
        raw: 'Arena Rock',
      })),
    })
    expect(
      plan(snapshots, [
        unknown,
        ...result.additions.map((row) => row.occurrence),
      ]).additions,
    ).toEqual([])
    expect(
      plan(snapshots, [
        unknown,
        { ...unknown, id: 'attributed', provider: 'google-custom-search' },
      ]).additions,
    ).toEqual([])
  })
  it.each([false, true])(
    'recovers legacy Last.fm singleton objects with an exact path (wrapped=%s)',
    (wrapped) => {
      const raw = {
        name: 'arena rock',
        url: 'https://www.last.fm/tag/arena+rock',
      }
      const album = { tags: { tag: raw } }
      const snapshots = [
        snapshot('lastfm', wrapped ? { album } : album),
        snapshot('legacy-record', { lastFm: album }),
      ]
      const result = plan(snapshots)
      expect(result.unresolved).toEqual([])
      expect(result.additions).toHaveLength(1)
      expect(result.additions[0]).toMatchObject({
        occurrence: {
          provider: 'lastfm',
          source: 'lastfm',
          sourceId: null,
          kind: 'genre',
        },
        evidence: [
          { path: `payload.${wrapped ? 'album.' : ''}tags.tag`, raw },
          { path: 'payload.lastFm.tags.tag', raw },
        ],
      })
      expect(
        plan(snapshots, [
          unknown,
          ...result.additions.map((row) => row.occurrence),
        ]).additions,
      ).toEqual([])
    },
  )
  it('does not duplicate normalized legacy Google evidence under a new RYM source', () => {
    const result = plan([
      snapshot(
        'google-custom-search',
        { rymGoogle: { genres: ['arena rock'] } },
        { normalizedData: { tags: [{ name: 'arena rock', kind: 'genre' }] } },
      ),
    ])
    expect(result.additions).toHaveLength(1)
    expect(result.additions[0]?.evidence).toHaveLength(2)
  })
  it('rejects malformed RYM arrays and unsupported locations instead of inferring tags', () => {
    for (const genres of [
      null,
      'arena rock',
      { name: 'arena rock' },
      ['arena rock', null],
      [{ name: 'arena rock' }],
    ]) {
      expect(
        snapshotTagEvidence(
          snapshot('google-custom-search', { rymGoogle: { genres } }),
        ),
      ).toEqual([])
    }
    for (const payload of [
      { genres: ['arena rock'] },
      { metacriticGoogle: { genres: ['arena rock'] } },
      {
        rymGoogle: {
          genres: [],
          snippet: 'Genres: arena rock.',
          rawResponse: {
            pagemap: {
              musicalbum: [{ genre: 'arena rock' }],
              metatags: [{ 'og:description': 'Genres: arena rock.' }],
            },
          },
        },
      },
      { artist: { rymGoogle: { genres: ['arena rock'] } } },
    ]) {
      expect(
        snapshotTagEvidence(snapshot('google-custom-search', payload)),
      ).toEqual([])
    }
    for (const provider of ['spotify', 'legacy-browser', 'rym']) {
      expect(
        snapshotTagEvidence(
          snapshot(provider, { rymGoogle: { genres: ['arena rock'] } }),
        ),
      ).toEqual([])
    }
    expect(
      snapshotTagEvidence(
        snapshot(
          'google-custom-search',
          { rymGoogle: { genres: ['arena rock'] } },
          { mediaType: 'film' },
        ),
      ),
    ).toEqual([])
  })
  it('restricts singleton recovery to legacy album tags.tag objects', () => {
    for (const tag of [
      null,
      'arena rock',
      1,
      {},
      { name: 1 },
      { name: '' },
      { name: '  ' },
    ]) {
      expect(
        snapshotTagEvidence(snapshot('lastfm', { tags: { tag } })),
      ).toEqual([])
    }
    for (const payload of [
      { toptags: { tag: { name: 'arena rock' } } },
      { artist: { tags: { tag: { name: 'arena rock' } } } },
      { wiki: { content: 'arena rock' } },
    ]) {
      expect(snapshotTagEvidence(snapshot('lastfm', payload))).toEqual([])
    }
    expect(
      snapshotTagEvidence(
        snapshot(
          'lastfm',
          { tags: { tag: { name: 'arena rock' } } },
          { source: 'scrape' },
        ),
      ),
    ).toEqual([])
    expect(
      snapshotTagEvidence(
        snapshot(
          'lastfm',
          { tags: { tag: { name: 'arena rock' } } },
          { mediaType: 'film' },
        ),
      ),
    ).toEqual([])
    const modern = snapshot(
      'lastfm',
      { album: { tags: { tag: [{ name: 'arena rock' }] } } },
      { source: 'scrape' },
    )
    expect(snapshotTagEvidence(modern)[0]?.tag.kind).toBe('general')
    expect(plan([modern]).additions).toEqual([])
  })
  it('reuses film normalizers without promoting MDBList opaque IDs to TMDb IDs', () => {
    const fetch = vi.fn(() => {
      throw new Error('No network')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const tmdb = snapshot(
        'tmdb',
        { genres: [{ id: 18, name: 'Drama' }] },
        { mediaType: 'film', mediaItemId: 'film-a' },
      )
      const mdblist = snapshot(
        'mdblist',
        { type: 'movie', keywords: [{ id: 42, name: 'tmdb.arena-rock' }] },
        { mediaType: 'film' },
      )
      expect(snapshotTagEvidence(mdblist)[0]?.tag).toMatchObject({
        source: 'tmdb',
        sourceId: 'mdblist:42',
        name: 'arena rock',
      })
      const result = planTagProvenanceBackfill({
        memberships: [
          {
            ...membership,
            mediaType: 'film',
            mediaItemId: 'film-a',
            name: 'Drama',
          },
        ],
        occurrences: [],
        snapshots: [tmdb, musicbrainz],
      })
      expect(result.additions).toHaveLength(1)
      expect(result.additions[0]?.link?.url).toBe(
        'https://www.themoviedb.org/genre/18-drama/movie',
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

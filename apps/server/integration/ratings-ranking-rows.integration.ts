import { expect, it, vi } from 'vitest'
import { RatingsRankingRequestSchema } from '@repo/schemas/ratings-explorer'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { database, pool, logQuery } = createTrackPerformanceFixture()
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

it('returns bounded album identity, tag, play and score evidence in one query with the filtered and library totals', async () => {
  const { rankRatings } = await import('@/services/ratings-explorer')
  const spotifyUrl = 'https://open.spotify.com/album/1234567890123456789012'
  await pool.query(`update media_item set title = 'Shared fixture ' || id
    where id in ('album-1', 'album-2');
    update media_item set artwork_url = 'https://example.test/artwork.webp',
      metadata = '{"browse":{"scrobbles":4,"ratingDiscogsValue":4,"ratingDiscogsVotes":6,"ratingMetacriticValue":80,"ratingMetacriticVotes":7}}'
    where id = 'album-1';
    update album set track_count = 3 where media_item_id = 'album-1';
    insert into media_credit (media_item_id, artist_id, role) values ('album-1','artist-1','artist');
    insert into tag (id,media_type,name) values ('tag-row','album','Ambient');
    insert into media_item_tag (media_item_id,tag_id) values ('album-1','tag-row');
    insert into provider_reference (id,media_item_id,provider,reference_type,external_id,metadata)
      values ('recording-reference','album-1','fixture','spotify','1234567890123456789012','{"largeFixture":"unrelated"}')`)
  await pool.query(
    `insert into external_link (id,media_item_id,provider,label,url)
    values ('recording-link','album-1','fixture','Recording',$1)`,
    [spotifyUrl],
  )
  const request = RatingsRankingRequestSchema.parse({
    library: 'album',
    search: 'Shared fixture',
    limit: 1,
  })
  logQuery.mockClear()
  const page = await rankRatings(request)
  expect(logQuery).toHaveBeenCalledTimes(1)
  expect(page).toMatchObject({
    total: 1,
    matchingTotal: 2,
    unscored: 1,
    libraryTotal: 1000,
  })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({
    id: 'album-1',
    title: 'Shared fixture album-1',
    artworkUrl: 'https://example.test/artwork.webp',
    credits: [{ id: 'artist-1', role: 'artist', name: 'Fixture artist 1' }],
    tags: ['Ambient'],
    plays: 4,
    watched: null,
    album: {
      spotifyUrl: null,
      trackCount: 3,
      links: [{ url: spotifyUrl }],
      providerReferences: [
        { referenceType: 'spotify', externalId: '1234567890123456789012' },
      ],
    },
    score: 50,
    counted: 2,
  })
  expect(JSON.stringify(page)).not.toContain('largeFixture')
  const next = await rankRatings({ ...request, scoredOnly: false, offset: 1 })
  expect(next).toMatchObject({ total: 2, matchingTotal: 2, unscored: 1 })
  expect(next.rows).toHaveLength(1)
  expect(next.rows[0]).toMatchObject({
    id: 'album-2',
    score: null,
    artworkUrl: null,
    credits: [],
    tags: [],
    album: { links: [], providerReferences: [] },
  })
  expect((await rankRatings(request, 'album-1')).rows).toEqual(page.rows)

  await pool.query(`insert into media_credit (media_item_id, artist_id, role) values ('album-2','artist-2','artist');
    insert into artist_provider_snapshot (id,artist_id,provider,normalized_data,payload)
      values ('artist-tag-profile','artist-2','lastfm','{"tags":["Ambient"]}','{}');
    insert into artist_provider_current_state (artist_id,provider,latest_snapshot_id)
      values ('artist-2','lastfm','artist-tag-profile')`)
  const genre = { ...request, tag: 'Ambient', scoredOnly: false, limit: 3 }
  expect((await rankRatings(genre)).total).toBe(2)
  const artistTag = await rankRatings({ ...genre, tagField: 'artistTag' })
  expect(artistTag.total).toBe(1)
  expect(artistTag.rows[0]).toMatchObject({
    id: 'album-2',
    tags: [],
    artistTags: ['Ambient'],
  })
})

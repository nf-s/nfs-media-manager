import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobSchema } from '@repo/schemas/job'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import {
  MIX_STATION_SYNC_TASKS,
  SPOTIFY_PODCAST_SYNC_TASK,
} from '@repo/schemas/subscriptions'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import {
  isSystemPath,
  libraryViewForPath,
  parseLibraryView,
  systemLibraryFilter,
  mediaScope,
  mediaScopeForPath,
  scopedHref,
  switchLibraryHref,
  switchMediaScopeHref,
  trackScopeRedirect,
  workspaceScopeForPath,
} from './media-scope'
import {
  jobMatchesScope,
  jobMediaScope,
  metadataLibrary,
} from './job-media-scope'

test('scope defaults to films and preserves existing deep-link parameters', () => {
  assert.equal(mediaScope(null), 'film')
  assert.equal(mediaScope('unsupported'), 'film')
  assert.equal(mediaScope('album'), 'album')
  const url = new URL(
    scopedHref('/jobs?jobId=one&batchId=two&status=failed', 'album'),
    'https://example.test',
  )
  assert.equal(url.searchParams.get('jobId'), 'one')
  assert.equal(url.searchParams.get('batchId'), 'two')
  assert.equal(url.searchParams.get('status'), 'failed')
  assert.equal(url.searchParams.get('mediaType'), 'album')
  assert.equal(
    scopedHref('/imports/csv?format=local%3Alist&mediaType=film', 'album'),
    '/imports/csv?format=local%3Alist&mediaType=album',
  )
})

test('creator and channel pages retain their own library context', () => {
  assert.equal(libraryViewForPath('/artists/one', null), 'artist')
  assert.equal(libraryViewForPath('/artists/one', 'track'), 'artist')
  assert.equal(libraryViewForPath('/people/one', 'album'), 'film')
  assert.equal(libraryViewForPath('/channels/one', 'film'), 'subscription')
  assert.equal(switchLibraryHref('/artists/one', '', 'film'), '/films')
  assert.equal(switchLibraryHref('/people/one', '', 'album'), '/albums')
  assert.equal(
    switchLibraryHref('/artists/one', 'mediaType=track', 'album'),
    '/albums',
  )
})

test('library switches keep the Matches destination and scope its query', () => {
  assert.equal(
    switchLibraryHref('/tracks/matches', 'q=fixture', 'track'),
    '/tracks/matches?q=fixture',
  )
  assert.equal(
    switchLibraryHref('/tracks/matches', 'q=fixture', 'album'),
    '/albums/matches',
  )
  assert.equal(
    switchLibraryHref('/albums/matches', 'sortBy=spotify', 'artist'),
    '/artists/matches',
  )
  assert.equal(
    switchLibraryHref('/artists/matches', '', 'film'),
    '/films/matches',
  )
  assert.equal(
    switchLibraryHref('/films/matches', '', 'subscription'),
    '/subscriptions/matches',
  )
  assert.equal(
    switchLibraryHref('/subscriptions/matches', '', 'track'),
    '/tracks/matches',
  )
})

test('Artists has independent browse and metadata destinations across library switches', () => {
  for (const path of ['/artists', '/artists/one']) {
    assert.equal(workspaceScopeForPath(path, 'album'), 'artist')
    assert.equal(libraryViewForPath(path, 'track'), 'artist')
    assert.equal(switchLibraryHref(path, 'mediaType=track', 'track'), '/tracks')
  }
  // Jobs and Providers belong to no library: choosing one opens its home.
  for (const path of ['/jobs', '/jobs/metadata', '/jobs/one', '/providers']) {
    assert.equal(workspaceScopeForPath(path, 'artist'), 'artist')
    assert.equal(
      switchLibraryHref(path, 'mediaType=album', 'artist'),
      '/artists',
    )
    assert.equal(
      switchLibraryHref(path, 'mediaType=artist', 'album'),
      '/albums',
    )
    assert.equal(switchLibraryHref(path, 'mediaType=film', 'film'), '/films')
    assert.equal(switchLibraryHref(path, '', 'track'), '/tracks')
    assert.equal(switchLibraryHref(path, '', 'subscription'), '/subscriptions')
  }
  for (const path of [
    '/albums',
    '/tracks',
    '/imports',
    '/imports/lastfm',
    '/providers',
    '/playlists',
    '/tags',
  ])
    assert.equal(
      switchLibraryHref(path, 'mediaType=track&q=fixture', 'artist'),
      '/artists',
    )
  assert.equal(
    switchLibraryHref('/artists', 'playlistIds=["one"]', 'artist'),
    '/artists?playlistIds=%5B%22one%22%5D',
  )
})

test('route-implied scope is consistent across library details and album import entry points', () => {
  for (const path of [
    '/albums',
    '/albums/first',
    '/imports/spotify',
    '/imports/lastfm',
    '/imports/albums',
  ])
    assert.equal(mediaScopeForPath(path, 'film'), 'album')
  for (const path of ['/films', '/films/first'])
    assert.equal(mediaScopeForPath(path, 'album'), 'film')
  for (const path of [
    '/imports',
    '/imports/csv',
    '/jobs/new',
    '/jobs/refresh',
    '/jobs/metadata',
    '/providers',
    '/tags',
  ])
    assert.equal(mediaScopeForPath(path, 'album'), 'album')
  assert.equal(mediaScopeForPath('/albums-other', null), 'film')
})

test('scoped links preserve fragments after the complete query', () => {
  assert.equal(
    scopedHref('/jobs?jobId=one#logs', 'album'),
    '/jobs?jobId=one&mediaType=album#logs',
  )
  assert.equal(
    scopedHref('/imports#recent', 'film'),
    '/imports?mediaType=film#recent',
  )
})

test('switching libraries drops record, provider and filter state but retains job status', () => {
  const search =
    'mediaType=film&provider=cinema&jobId=one&batchId=two&mediaItemId=three&q=title&status=attention&filters=[]&page=4'
  assert.equal(
    switchMediaScopeHref('/jobs', search, 'album'),
    '/jobs?status=attention&mediaType=album',
  )
  assert.equal(
    switchMediaScopeHref('/providers', search, 'album'),
    '/providers?mediaType=album',
  )
  assert.equal(
    switchMediaScopeHref('/jobs/new', search, 'album'),
    '/jobs/new?mediaType=album',
  )
  assert.equal(
    switchMediaScopeHref('/jobs/refresh', search, 'album'),
    '/jobs/refresh?mediaType=album',
  )
  assert.equal(
    switchMediaScopeHref('/jobs/metadata', search, 'album'),
    '/jobs/metadata?mediaType=album',
  )
  assert.equal(
    switchMediaScopeHref('/tags/hidden', `${search}&tag=old-tag`, 'album'),
    '/tags/hidden?mediaType=album',
  )
})

test('scope changes leave incompatible imports and media details for the target library', () => {
  for (const path of ['/imports/spotify', '/imports/lastfm', '/imports/albums'])
    assert.equal(
      switchMediaScopeHref(path, 'format=old&mediaType=album', 'film'),
      '/imports?mediaType=film',
    )
  for (const path of ['/imports/csv', '/imports/nfo', '/imports/legacy'])
    assert.equal(
      switchMediaScopeHref(path, 'format=old&mediaType=film', 'album'),
      '/imports?mediaType=album',
    )
  assert.equal(
    switchMediaScopeHref('/albums/one', 'item=one&filters=[]', 'film'),
    '/films',
  )
  assert.equal(
    switchMediaScopeHref('/films', 'item=two&columns=imdb&view=table', 'album'),
    '/albums',
  )
})

test('selecting the current library is a no-op that retains deep links and filters', () => {
  assert.equal(
    switchMediaScopeHref(
      '/jobs',
      'mediaType=album&jobId=one&provider=music',
      'album',
    ),
    '/jobs?mediaType=album&jobId=one&provider=music',
  )
  assert.equal(
    switchMediaScopeHref('/albums', 'q=artist&view=table', 'album'),
    '/albums?q=artist&view=table',
  )
  assert.equal(
    switchMediaScopeHref('/imports/spotify', '', 'album'),
    '/imports/spotify',
  )
})

test('tracks have their own library view while album metadata retains its scope', () => {
  for (const path of [
    '/tracks',
    '/tracks/first',
    '/playlists',
    '/imports/spotify-playlists',
  ])
    assert.equal(mediaScopeForPath(path, 'film'), 'album')
  for (const path of ['/tracks', '/tracks/first', '/playlists'])
    assert.equal(libraryViewForPath(path, 'film'), 'track')
  assert.equal(libraryViewForPath('/albums', null), 'album')
  assert.equal(libraryViewForPath('/imports/spotify-playlists', null), 'album')
  assert.equal(libraryViewForPath('/tags', 'album'), 'album')
  assert.equal(libraryViewForPath('/tags', null), 'film')
  assert.equal(libraryViewForPath('/tracks-other', null), 'film')
})

test('track imports retain their library across shared music import routes', () => {
  for (const path of [
    '/imports',
    '/imports/spotify-playlists',
    '/imports/lastfm',
  ])
    assert.equal(libraryViewForPath(path, 'track'), 'track')
  assert.equal(libraryViewForPath('/albums/linked-album', 'track'), 'album')
  assert.equal(
    switchLibraryHref('/imports/lastfm', 'mediaType=track', 'track'),
    '/imports/lastfm?mediaType=track',
  )
  assert.equal(
    switchLibraryHref('/imports/albums', 'mediaType=album', 'track'),
    '/imports/spotify-playlists?mediaType=track',
  )
  assert.equal(
    switchLibraryHref('/imports/lastfm', 'mediaType=track', 'album'),
    '/imports/lastfm?mediaType=album',
  )
  assert.equal(
    scopedHref('/imports/lastfm?tab=history', 'track'),
    '/imports/lastfm?tab=history&mediaType=track',
  )
})

test('playlists retain the Albums or Tracks context that opened them', () => {
  assert.equal(libraryViewForPath('/playlists', 'album'), 'album')
  assert.equal(libraryViewForPath('/playlists', 'track'), 'track')
  assert.equal(libraryViewForPath('/playlists', null), 'track')
  assert.equal(libraryViewForPath('/playlists/example', 'album'), 'album')
  assert.equal(
    switchLibraryHref(
      '/playlists',
      'mediaType=album&playlist=example',
      'track',
    ),
    '/playlists?mediaType=track&playlist=example',
  )
  assert.equal(
    switchLibraryHref(
      '/playlists',
      'mediaType=track&playlist=example',
      'album',
    ),
    '/playlists?mediaType=album&playlist=example',
  )
  assert.equal(
    switchLibraryHref('/playlists', 'mediaType=album', 'film'),
    '/films',
  )
  assert.equal(
    switchLibraryHref('/playlists', 'mediaType=album', 'subscription'),
    '/subscriptions',
  )
})

test('switching between Albums and Tracks keeps the shared import source', () => {
  for (const path of ['/imports/lastfm', '/imports/spotify-playlists']) {
    assert.equal(
      switchLibraryHref(path, 'mediaType=album&q=fixture', 'track'),
      `${path}?mediaType=track`,
    )
    assert.equal(
      switchLibraryHref(path, 'mediaType=track&q=fixture', 'album'),
      `${path}?mediaType=album`,
    )
    assert.equal(
      switchLibraryHref(path, 'mediaType=track&q=fixture', 'film'),
      '/imports?mediaType=film',
    )
  }
  for (const path of [
    '/imports',
    '/imports/spotify',
    '/imports/albums',
    '/imports/csv',
  ])
    assert.equal(
      switchLibraryHref(path, 'mediaType=album', 'track'),
      '/imports/spotify-playlists?mediaType=track',
    )
})

test('unsupported track links return to Tracks without rendering another library', () => {
  for (const path of ['/tags', '/tags/hidden', '/providers']) {
    assert.equal(libraryViewForPath(path, 'track'), 'track')
    assert.equal(trackScopeRedirect(path, 'track'), '/tracks')
    assert.equal(trackScopeRedirect(path, 'album'), null)
  }
  for (const path of ['/imports/csv', '/imports/legacy', '/imports/albums'])
    assert.equal(
      trackScopeRedirect(path, 'track'),
      '/imports/spotify-playlists?mediaType=track',
    )
  for (const path of [
    '/tracks',
    '/jobs',
    '/jobs/metadata',
    '/playlists',
    '/imports/lastfm',
    '/imports/spotify-playlists',
    '/albums/linked-album',
  ])
    assert.equal(trackScopeRedirect(path, 'track'), null)
})

test('collections follow the Films or Albums scope and switching clears collection detail state', () => {
  assert.equal(mediaScopeForPath('/collections', 'album'), 'album')
  assert.equal(libraryViewForPath('/collections', 'album'), 'album')
  assert.equal(libraryViewForPath('/collections/example', 'album'), 'album')
  assert.equal(libraryViewForPath('/collections/example', null), 'film')
  assert.equal(workspaceScopeForPath('/collections', 'subscription'), 'film')
  assert.equal(
    switchLibraryHref('/collections', 'collection=example', 'album'),
    '/collections?mediaType=album',
  )
  assert.equal(
    switchLibraryHref('/collections', 'collection=example', 'track'),
    '/tracks',
  )
  assert.equal(
    switchLibraryHref('/collections', 'collection=example', 'subscription'),
    '/subscriptions',
  )
  assert.equal(
    switchLibraryHref('/collections', 'collection=example', 'film'),
    '/collections?collection=example',
  )
})

test('the library selector moves between albums, tracks and films', () => {
  assert.equal(
    switchLibraryHref('/albums', 'q=artist&view=table', 'track'),
    '/tracks',
  )
  assert.equal(switchLibraryHref('/tags', 'mediaType=film', 'track'), '/tracks')
  assert.equal(switchLibraryHref('/tracks', 'q=title', 'album'), '/albums')
  assert.equal(switchLibraryHref('/playlists', '', 'film'), '/films')
  assert.equal(
    switchLibraryHref('/tracks', 'q=title&sortBy=scrobbles', 'track'),
    '/tracks?q=title&sortBy=scrobbles',
  )
  assert.equal(
    switchLibraryHref('/imports/spotify-playlists', '', 'film'),
    '/imports?mediaType=film',
  )
})

test('Subscriptions is a separate library scoped by path or mediaType', () => {
  for (const path of [
    '/subscriptions',
    '/subscriptions/channels',
    '/imports/youtube',
    '/imports/spotify-podcasts',
  ]) {
    assert.equal(workspaceScopeForPath(path, 'album'), 'subscription')
    assert.equal(libraryViewForPath(path, 'album'), 'subscription')
  }
  for (const path of ['/jobs', '/providers', '/imports'])
    assert.equal(libraryViewForPath(path, 'subscription'), 'subscription')
  // Paths that imply a media library win over the parameter.
  assert.equal(
    workspaceScopeForPath('/imports/spotify', 'subscription'),
    'album',
  )
  assert.equal(workspaceScopeForPath('/films/one', 'subscription'), 'film')
  assert.equal(libraryViewForPath('/tracks', 'subscription'), 'track')
  assert.equal(libraryViewForPath('/subscriptions-other', null), 'film')
  assert.equal(workspaceScopeForPath('/jobs', 'album'), 'album')
  assert.equal(workspaceScopeForPath('/providers', null), 'film')
  // Browse and tag code keeps a media scope.
  assert.equal(mediaScopeForPath('/subscriptions', 'album'), 'album')
  assert.equal(mediaScopeForPath('/jobs', 'subscription'), 'film')
  assert.equal(
    scopedHref('/jobs?status=failed', 'subscription'),
    '/jobs?status=failed&mediaType=subscription',
  )
})

test('switching to Subscriptions keeps Imports and otherwise browses', () => {
  for (const path of [
    '/albums',
    '/films/one',
    '/tracks',
    '/tags',
    '/playlists',
  ])
    assert.equal(
      switchLibraryHref(path, 'mediaType=album&q=title', 'subscription'),
      '/subscriptions',
    )
  assert.equal(
    switchLibraryHref('/imports/spotify', '', 'subscription'),
    '/imports/youtube?mediaType=subscription',
  )
  assert.equal(
    switchLibraryHref('/imports/csv', 'format=ratings', 'subscription'),
    '/imports/youtube?mediaType=subscription',
  )
  assert.equal(
    switchLibraryHref('/subscriptions', 'q=talk&view=list', 'subscription'),
    '/subscriptions?q=talk&view=list',
  )
  assert.equal(
    switchLibraryHref('/imports/spotify-podcasts', '', 'subscription'),
    '/imports/spotify-podcasts',
  )
})

test('switching from Subscriptions keeps Imports and otherwise browses', () => {
  assert.equal(
    switchLibraryHref('/subscriptions', 'q=talk', 'album'),
    '/albums',
  )
  assert.equal(
    switchLibraryHref('/subscriptions/channels', '', 'film'),
    '/films',
  )
  assert.equal(
    switchLibraryHref('/subscriptions/channels', '', 'track'),
    '/tracks',
  )
  assert.equal(
    switchLibraryHref('/imports/youtube', 'mediaType=subscription', 'album'),
    '/imports?mediaType=album',
  )
})

function job(mediaType: 'album' | 'film' | null) {
  return JobSchema.parse({
    id: 'job',
    provider: 'multi-media',
    status: 'failed',
    createdAt: '2026-01-01',
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    scope: { mediaType: 'film' },
    options: {},
    confirmBroadRun: false,
    logs: [],
    items: [
      {
        id: 'item',
        mediaItemId: 'album-1',
        mediaType,
        provider: 'multi-media',
        status: 'failed',
        attemptCount: 1,
        message: null,
        createdAt: '2026-01-01',
        startedAt: null,
        finishedAt: null,
      },
    ],
  })
}

test('job media filtering uses actual items, not provider capability or stale scope', () => {
  assert.equal(jobMatchesScope(job('album'), 'album'), true)
  assert.equal(jobMatchesScope(job('album'), 'film'), false)
  assert.equal(jobMediaScope(job('album')), 'album')
  assert.equal(jobMatchesScope(job(null), 'film'), true)
  assert.equal(jobMatchesScope(job(null), 'album'), false)
})

function taskJob(task: string, mediaType: 'album' | 'track' | null) {
  return JobSchema.parse({
    ...job(null),
    scope: { mediaType },
    options: { task },
    items: [],
  })
}

test('Spotify track search jobs belong to Tracks', () => {
  const search = taskJob(SPOTIFY_TRACK_SEARCH_TASK, 'track')
  assert.equal(jobMediaScope(search), 'track')
  assert.equal(jobMatchesScope(search, 'track'), true)
  assert.equal(jobMatchesScope(search, 'album'), false)
})

test('subscription syncs belong to Subscriptions, including ones stored as album jobs', () => {
  for (const sync of [
    taskJob(YOUTUBE_SYNC_TASK, 'album'),
    taskJob(SPOTIFY_PODCAST_SYNC_TASK, null),
  ]) {
    assert.equal(jobMediaScope(sync), 'subscription')
    assert.equal(jobMatchesScope(sync, 'subscription'), true)
    assert.equal(jobMatchesScope(sync, 'album'), false)
    assert.equal(jobMatchesScope(sync, 'film'), false)
  }
  assert.equal(jobMatchesScope(job('album'), 'subscription'), false)
  assert.equal(
    jobMatchesScope(taskJob('lastfm-scrobble-sync', 'album'), 'album'),
    true,
  )
})

test('artist jobs belong only to Artists even when stored with legacy album scope', () => {
  for (const artistJob of [
    taskJob(ARTIST_ENRICHMENT_TASK, 'album'),
    taskJob(ARTIST_ENRICHMENT_TASK, null),
  ]) {
    assert.equal(jobMediaScope(artistJob), 'artist')
    assert.equal(jobMatchesScope(artistJob, 'artist'), true)
    assert.equal(jobMatchesScope(artistJob, 'album'), false)
    assert.equal(jobMatchesScope(artistJob, 'film'), false)
    assert.equal(jobMatchesScope(artistJob, 'subscription'), false)
  }
  assert.equal(jobMatchesScope(job('album'), 'artist'), false)
  assert.equal(
    jobMatchesScope(taskJob(YOUTUBE_SYNC_TASK, 'album'), 'artist'),
    false,
  )
})

test('Jobs and Providers are System pages with a library filter', () => {
  for (const path of ['/jobs', '/jobs/metadata', '/jobs/one', '/providers'])
    assert.equal(isSystemPath(path), true)
  for (const path of ['/jobsite', '/albums', '/imports', '/provider'])
    assert.equal(isSystemPath(path), false)
  assert.equal(systemLibraryFilter(null), null)
  assert.equal(systemLibraryFilter('track'), null)
  assert.equal(systemLibraryFilter('unsupported'), null)
  for (const value of ['album', 'film', 'artist', 'subscription'])
    assert.equal(systemLibraryFilter(value), value)
  assert.equal(parseLibraryView('track'), 'track')
  assert.equal(parseLibraryView('other'), null)
})

test('Metadata selects from the linked library, then the rail, then Albums', () => {
  assert.equal(metadataLibrary('film', 'artist'), 'film')
  assert.equal(metadataLibrary('subscription', 'artist'), 'artist')
  assert.equal(metadataLibrary(null, 'track'), 'track')
  assert.equal(metadataLibrary(null), 'album')
})

test('Mixes is a separate library scoped by path or mediaType', () => {
  for (const path of [
    '/mixes',
    '/mixes/shows',
    '/mixes/shows/nts.example-show',
    '/mixes/nts.example-mix',
    '/imports/rinse',
    '/imports/nts',
    '/imports/lotradio',
  ]) {
    assert.equal(workspaceScopeForPath(path, 'subscription'), 'mix')
    assert.equal(libraryViewForPath(path, 'album'), 'mix')
  }
  for (const path of ['/jobs', '/providers', '/imports'])
    assert.equal(libraryViewForPath(path, 'mix'), 'mix')
  assert.equal(libraryViewForPath('/mixes-other', null), 'film')
  assert.equal(systemLibraryFilter('mix'), 'mix')
  assert.equal(parseLibraryView('mix'), 'mix')
  assert.equal(
    scopedHref('/jobs?status=failed', 'mix'),
    '/jobs?status=failed&mediaType=mix',
  )
})

test('switching to and from Mixes keeps Imports, Jobs and Providers and otherwise browses', () => {
  for (const path of ['/albums', '/subscriptions/channels', '/tracks', '/tags'])
    assert.equal(
      switchLibraryHref(path, 'mediaType=album&q=title', 'mix'),
      '/mixes',
    )
  // Mixes has no Matches page.
  assert.equal(switchLibraryHref('/albums/matches', '', 'mix'), '/mixes')
  assert.equal(
    switchLibraryHref('/imports/youtube', 'mediaType=subscription', 'mix'),
    '/imports/rinse?mediaType=mix',
  )
  assert.equal(
    switchLibraryHref('/imports/spotify-playlists', 'mediaType=track', 'mix'),
    '/imports/rinse?mediaType=mix',
  )
  assert.equal(
    switchLibraryHref('/mixes', 'q=late&view=list', 'mix'),
    '/mixes?q=late&view=list',
  )
  assert.equal(switchLibraryHref('/imports/nts', '', 'mix'), '/imports/nts')
  assert.equal(
    switchLibraryHref('/mixes/shows', '', 'subscription'),
    '/subscriptions',
  )
  assert.equal(switchLibraryHref('/mixes', '', 'track'), '/tracks')
  assert.equal(switchLibraryHref('/mixes/shows', '', 'album'), '/albums')
  assert.equal(
    switchLibraryHref('/imports/lotradio', 'mediaType=mix', 'album'),
    '/imports?mediaType=album',
  )
  assert.equal(
    switchLibraryHref('/imports/nts', '', 'subscription'),
    '/imports/youtube?mediaType=subscription',
  )
  assert.equal(
    switchMediaScopeHref('/jobs/one', 'status=failed', 'mix'),
    '/jobs?status=failed&mediaType=mix',
  )
  assert.equal(
    switchMediaScopeHref('/providers', '', 'mix'),
    '/providers?mediaType=mix',
  )
  assert.equal(switchMediaScopeHref('/tags', '', 'mix'), '/mixes')
})

test('mix syncs belong only to Mixes', () => {
  const scopes: Array<'album' | null> = ['album', null]
  for (const task of Object.values(MIX_STATION_SYNC_TASKS))
    for (const mediaType of scopes) {
      const sync = taskJob(task, mediaType)
      assert.equal(jobMediaScope(sync), 'mix')
      assert.equal(jobMatchesScope(sync, 'mix'), true)
      assert.equal(jobMatchesScope(sync, 'subscription'), false)
      assert.equal(jobMatchesScope(sync, 'album'), false)
    }
  assert.equal(jobMatchesScope(job('album'), 'mix'), false)
  assert.equal(jobMatchesScope(taskJob(YOUTUBE_SYNC_TASK, null), 'mix'), false)
  assert.equal(metadataLibrary('mix', 'artist'), 'artist')
})

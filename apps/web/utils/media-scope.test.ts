import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobSchema } from '@repo/schemas/job'
import { SPOTIFY_PODCAST_SYNC_TASK } from '@repo/schemas/subscriptions'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import {
  libraryViewForPath,
  mediaScope,
  mediaScopeForPath,
  scopedHref,
  switchLibraryHref,
  switchMediaScopeHref,
  workspaceScopeForPath,
} from './media-scope'
import { jobMatchesScope, jobMediaScope } from './job-media-scope'

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

test('tracks and playlists are a view of the album library', () => {
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

test('collections stay in Films and switching libraries leaves collection detail state', () => {
  assert.equal(mediaScopeForPath('/collections', 'album'), 'film')
  assert.equal(libraryViewForPath('/collections', 'album'), 'film')
  assert.equal(workspaceScopeForPath('/collections', 'subscription'), 'film')
  assert.equal(
    switchLibraryHref('/collections', 'collection=example', 'album'),
    '/albums',
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
    switchLibraryHref('/jobs', 'mediaType=film&status=failed', 'album'),
    '/jobs?status=failed&mediaType=album',
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

test('switching to Subscriptions keeps Imports, Jobs and Providers and otherwise browses', () => {
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
    switchLibraryHref(
      '/jobs/metadata',
      'mediaType=album&status=failed&jobId=one',
      'subscription',
    ),
    '/jobs?status=failed&mediaType=subscription',
  )
  assert.equal(
    switchLibraryHref(
      '/providers',
      'mediaType=film&provider=cinema',
      'subscription',
    ),
    '/providers?mediaType=subscription',
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

test('switching from Subscriptions keeps Imports, Jobs and Providers and otherwise browses', () => {
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
  assert.equal(
    switchLibraryHref('/jobs', 'mediaType=subscription&status=queued', 'film'),
    '/jobs?status=queued&mediaType=film',
  )
  assert.equal(
    switchLibraryHref(
      '/providers',
      'mediaType=subscription&provider=youtube',
      'album',
    ),
    '/providers?mediaType=album',
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

function taskJob(task: string, mediaType: 'album' | null) {
  return JobSchema.parse({
    ...job(null),
    scope: { mediaType },
    options: { task },
    items: [],
  })
}

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

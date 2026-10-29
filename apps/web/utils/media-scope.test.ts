import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobSchema } from '@repo/schemas/job'
import {
  mediaScope,
  mediaScopeForPath,
  scopedHref,
  switchMediaScopeHref,
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
  for (const path of ['/imports/spotify', '/imports/albums'])
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

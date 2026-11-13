import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  subscriptionsHrefFromYoutube,
  youtubeImportHrefFromSubscriptions,
} from './youtube-redirects'

function query(href: string) {
  return new URL(href, 'http://localhost').searchParams
}

test('old video links keep search, view, sort and the open video', () => {
  const href = subscriptionsHrefFromYoutube({
    q: ' sourdough ',
    fields: 'title',
    view: 'list',
    sortBy: 'viewCount',
    sortDirection: 'asc',
    video: 'dQw4w9WgXcQ',
    channelId: ['UCaaaaaaaaaaaaaaaaaaaaaa', 'UCbbbbbbbbbbbbbbbbbbbbbb'],
    duration: 'long',
  })
  assert.ok(href.startsWith('/subscriptions?'))
  assert.deepEqual(Object.fromEntries(query(href)), {
    q: 'sourdough',
    fields: 'title',
    sortBy: 'viewCount',
    direction: 'asc',
    view: 'list',
    item: 'dQw4w9WgXcQ',
  })
})

test('published days become one inclusive UTC range in epoch milliseconds', () => {
  const both = query(
    subscriptionsHrefFromYoutube({
      publishedFrom: '2026-01-02',
      publishedTo: '2026-01-31',
    }),
  )
  assert.deepEqual(JSON.parse(both.get('ranges') ?? ''), [
    {
      field: 'publishedAt',
      min: Date.UTC(2026, 0, 2),
      max: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
      includeMissing: false,
    },
  ])
  const from = query(
    subscriptionsHrefFromYoutube({ publishedFrom: '2026-01-02' }),
  )
  assert.deepEqual(JSON.parse(from.get('ranges') ?? ''), [
    { field: 'publishedAt', min: Date.UTC(2026, 0, 2), includeMissing: false },
  ])
})

test('invalid or meaningless old parameters are dropped', () => {
  assert.equal(
    subscriptionsHrefFromYoutube({
      fields: 'title',
      sortBy: 'relevance',
      sortDirection: 'up',
      view: 'table',
      publishedFrom: '2026-13-40',
      video: 'not a video',
    }),
    '/subscriptions',
  )
  assert.equal(subscriptionsHrefFromYoutube({}), '/subscriptions')
  assert.equal(
    query(subscriptionsHrefFromYoutube({ q: 'talk', sortBy: 'relevance' })).get(
      'sortBy',
    ),
    'relevance',
  )
})

test('the old subscriptions page opens the YouTube import page with the OAuth outcome', () => {
  assert.equal(
    youtubeImportHrefFromSubscriptions({}),
    '/imports/youtube?mediaType=subscription',
  )
  for (const outcome of ['connected', 'error'])
    assert.equal(
      youtubeImportHrefFromSubscriptions({ youtube: outcome }),
      `/imports/youtube?mediaType=subscription&youtube=${outcome}`,
    )
  assert.equal(
    youtubeImportHrefFromSubscriptions({ youtube: 'https://example.test' }),
    '/imports/youtube?mediaType=subscription',
  )
})

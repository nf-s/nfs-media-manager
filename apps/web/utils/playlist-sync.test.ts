import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaylistSummarySchema } from '@repo/schemas/tracks'
import {
  formatPlaylistDuration,
  playlistImportRequest,
  playlistJobProgress,
  playlistNextSync,
  playlistSourceLabel,
  spotifyPlaylistId,
} from './playlist-sync'

const spotifyId = '1234567890ABCDEFGHIJKL'
const playlist = PlaylistSummarySchema.parse({
  id: 'playlist-1',
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: 'Example owner',
  description: null,
  artworkUrl: null,
  spotifyUrl: `https://open.spotify.com/playlist/${spotifyId}`,
  importedAt: null,
  trackCount: 0,
  linkedTrackCount: 0,
  albumCount: 0,
  durationSec: 0,
  sync: {
    syncable: true,
    schedule: 'daily',
    lastCheckedAt: null,
    nextScheduledAt: null,
    job: null,
  },
})
const job = (status: 'queued' | 'running' | 'failed' | 'cancelled') => ({
  jobId: 'job-1',
  status,
  errorMessage: null,
  finishedAt: null,
  progress: null,
})

test('import progress counts pages, with the total once it is known', () => {
  assert.equal(playlistJobProgress(null), null)
  assert.equal(
    playlistJobProgress({ pagesRead: 2, totalPages: 5 }),
    '2 of 5 pages',
  )
  assert.equal(
    playlistJobProgress({ pagesRead: 2, totalPages: null }),
    '2 pages',
  )
})

test('the next sync is a time or the reason there is none', () => {
  const at = '2026-01-03T04:05:00.000Z'
  assert.equal(
    playlistNextSync({ ...playlist.sync, nextScheduledAt: at }),
    new Date(at).toLocaleString(),
  )
  assert.equal(
    playlistNextSync({ ...playlist.sync, schedule: 'off' }),
    'Schedule off',
  )
  for (const status of ['queued', 'running'] as const)
    assert.equal(
      playlistNextSync({ ...playlist.sync, job: job(status) }),
      'Import in progress',
    )
  assert.match(
    playlistNextSync({ ...playlist.sync, job: job('failed') }),
    /last import failed\. Sync now to resume/,
  )
  assert.match(
    playlistNextSync({ ...playlist.sync, job: job('cancelled') }),
    /last import was cancelled\. Sync now to resume/,
  )
})

test('sync now imports the Spotify playlist or Liked Songs', () => {
  assert.deepEqual(playlistImportRequest(playlist), {
    playlists: [{ spotifyId, name: 'Synthetic mix' }],
    likedSongs: false,
    confirmBroadRun: false,
  })
  assert.deepEqual(
    playlistImportRequest({
      ...playlist,
      source: 'spotify-liked',
      spotifyUrl: null,
    }),
    { playlists: [], likedSongs: true, confirmBroadRun: false },
  )
  assert.equal(
    playlistImportRequest({
      ...playlist,
      source: null,
      sync: { ...playlist.sync, syncable: false },
    }),
    null,
  )
  assert.equal(playlistImportRequest({ ...playlist, spotifyUrl: null }), null)
})

test('playlist IDs come only from Spotify playlist URLs', () => {
  assert.equal(
    spotifyPlaylistId(`https://open.spotify.com/playlist/${spotifyId}`),
    spotifyId,
  )
  assert.equal(
    spotifyPlaylistId(`https://open.spotify.com/album/${spotifyId}`),
    null,
  )
  assert.equal(spotifyPlaylistId(null), null)
})

test('sources and durations are labelled for the playlist table', () => {
  assert.equal(playlistSourceLabel('spotify'), 'Spotify')
  assert.equal(playlistSourceLabel('spotify-liked'), 'Liked Songs')
  assert.equal(playlistSourceLabel(null), 'Library')
  assert.equal(formatPlaylistDuration(3900), '1 h 5 min')
  assert.equal(formatPlaylistDuration(600), '10 min')
})

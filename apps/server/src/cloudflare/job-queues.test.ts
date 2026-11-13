import { describe, expect, it } from 'vitest'
import { providerJobQueue } from './job-queues'

const queues = {
  SCRAPE_QUEUE: 'default',
  SCRAPE_QUEUE_LASTFM: 'lastfm',
  SCRAPE_QUEUE_SPOTIFY: 'spotify',
  SCRAPE_QUEUE_YOUTUBE: 'youtube',
}

describe('providerJobQueue', () => {
  it.each(['lastfm', 'spotify', 'youtube'])(
    'gives %s, which runs long syncs, its own queue',
    (provider) => {
      expect(providerJobQueue(queues, provider)).toBe(provider)
    },
  )

  it.each(['musicbrainz', 'tmdb', 'fixture'])(
    'keeps %s on the default queue',
    (provider) => {
      expect(providerJobQueue(queues, provider)).toBe('default')
    },
  )
})

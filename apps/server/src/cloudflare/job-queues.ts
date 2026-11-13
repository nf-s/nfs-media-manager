type JobQueueBinding =
  | 'SCRAPE_QUEUE'
  | 'SCRAPE_QUEUE_LASTFM'
  | 'SCRAPE_QUEUE_SPOTIFY'
  | 'SCRAPE_QUEUE_YOUTUBE'

/**
 * The queue a provider's jobs are delivered on. A queue adds consumers only
 * after a batch finishes, so a sync that runs for minutes holds back every
 * message behind it. Providers with such syncs each get their own queue and
 * never wait on one another; the rest share the default queue, where a job
 * takes seconds.
 */
export function providerJobQueue<Q>(
  queues: Record<JobQueueBinding, Q>,
  provider: string,
): Q {
  switch (provider) {
    case 'lastfm':
      return queues.SCRAPE_QUEUE_LASTFM
    case 'spotify':
      return queues.SCRAPE_QUEUE_SPOTIFY
    case 'youtube':
      return queues.SCRAPE_QUEUE_YOUTUBE
    default:
      return queues.SCRAPE_QUEUE
  }
}

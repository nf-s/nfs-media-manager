import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// All application pages are dynamic. Do not enable shared ISR/data caching.
export default defineCloudflareConfig({
  incrementalCache: 'dummy',
  tagCache: 'dummy',
  queue: 'dummy',
  enableCacheInterception: false,
})

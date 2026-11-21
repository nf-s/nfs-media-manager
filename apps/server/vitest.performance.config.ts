import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // The Mixes suite checks the Artist Overview query against a common
      // search term across a full-size synthetic broadcast library.
      include: [
        'integration/**/*.performance.ts',
        'integration/query-indexes.integration.ts',
        'integration/mixes-library.integration.ts',
      ],
      fileParallelism: false,
    },
  }),
)

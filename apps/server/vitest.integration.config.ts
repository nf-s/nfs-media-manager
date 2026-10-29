import { mergeConfig, defineConfig } from 'vitest/config'
import base from './vitest.config'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['integration/**/*.integration.ts'],
      fileParallelism: false,
    },
  }),
)

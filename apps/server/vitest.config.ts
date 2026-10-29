import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      '@repo/schemas': fileURLToPath(new URL('../../packages/schemas/src', import.meta.url)),
      '@repo/media-plugin-sdk': fileURLToPath(
        new URL('../../packages/media-plugin-sdk/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    fileParallelism: true,
    environment: 'node',
    hookTimeout: 120000,
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 120000,
  },
})

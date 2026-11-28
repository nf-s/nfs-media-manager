import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@repo/media-plugin-sdk/local-worker': fileURLToPath(
        new URL(
          '../../packages/media-plugin-sdk/src/local-worker.ts',
          import.meta.url,
        ),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      '@repo/schemas': fileURLToPath(
        new URL('../../packages/schemas/src', import.meta.url),
      ),
      // The device parity suite reads the store package from its source.
      '@repo/library-source/better-sqlite3': fileURLToPath(
        new URL(
          '../../packages/library-source/src/drivers/better-sqlite3.ts',
          import.meta.url,
        ),
      ),
      '@repo/library-source': fileURLToPath(
        new URL('../../packages/library-source/src/index.ts', import.meta.url),
      ),
      '@repo/media-plugin-sdk': fileURLToPath(
        new URL(
          '../../packages/media-plugin-sdk/src/index.ts',
          import.meta.url,
        ),
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

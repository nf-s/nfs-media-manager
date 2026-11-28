import { defineConfig } from 'vitest/config'

/** `vitest run --mode measure` runs the size and speed measurements instead of the tests. */
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: mode === 'measure' ? ['tests/measure.ts'] : ['tests/**/*.test.ts'],
  },
}))

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  opendir: vi.fn(),
  plugins: vi.fn(async () => []),
}))
vi.mock('@/env', () => ({
  env: { RUNTIME_KIND: 'cloudflare', SCAN_DIR: '/private/library' },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('node:fs/promises', () => ({
  lstat: mocks.lstat,
  stat: mocks.stat,
  readFile: mocks.readFile,
  opendir: mocks.opendir,
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: mocks.plugins,
}))
vi.mock('../provider-state', () => ({
  applyProviderResultInTransaction: vi.fn(),
}))
vi.mock('../film-enrichment', () => ({
  queueFilmEnrichment: vi.fn(),
  requireEnrichmentConfirmation: vi.fn(),
  validateFilmProviders: vi.fn(),
}))
import { getNfoSource, prepareFilmImport } from '../film-imports'
import {
  collectFilmRecords,
  nfoFiles,
  previewFileImport,
  readNfoFile,
  startFileImport,
} from '../file-imports'

describe('cloud file import boundaries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('disables NFO source discovery and traversal without touching configured paths', async () => {
    expect(await getNfoSource()).toEqual({ path: null, available: false })
    await expect(prepareFilmImport({ kind: 'nfo' }, 'owner')).rejects.toThrow(
      'unavailable in cloud',
    )
    await expect(nfoFiles('/private/library').next()).rejects.toThrow(
      'unavailable in cloud',
    )
    await expect(readNfoFile('/private/library/movie.nfo')).rejects.toThrow(
      'unavailable in cloud',
    )
    expect(mocks.lstat).not.toHaveBeenCalled()
    expect(mocks.opendir).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('rejects all server-path CSV preview and import entrypoints', async () => {
    const input = {
      format: 'imdb-watchlist',
      path: '/private/list.csv',
      fullImport: false,
      limit: 3,
    }
    await expect(collectFilmRecords(input)).rejects.toThrow('Upload a CSV')
    await expect(previewFileImport(input)).rejects.toThrow('Upload a CSV')
    await expect(startFileImport(input, 'owner')).rejects.toThrow(
      'Upload a CSV',
    )
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('parses uploaded CSV content without filesystem access or provider requests', async () => {
    const result = await collectFilmRecords(
      {
        format: 'imdb-watchlist',
        path: 'watchlist.csv',
        fullImport: true,
        limit: 3,
      },
      'Const,Title,Created\ntt1234567,Example,2026-01-01',
    )
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.result.normalized.mediaPatch?.title).toBe(
      'Example',
    )
    expect(mocks.lstat).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
})

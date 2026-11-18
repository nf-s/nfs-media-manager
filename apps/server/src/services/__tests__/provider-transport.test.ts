import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  createDirectProviderRequest,
  createProviderRequest,
} from '@/services/provider-requests'
import { withProviderTransport } from '@/services/provider-transport'

vi.mock('@/lib/db', () => ({ db: {} }))

const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    localWorkerRequired: true,
    localWorker: {
      origin: 'https://fixture.invalid',
      paths: ['/metadata'],
      credentialHeaders: [],
      queryParameters: [],
    },
  },
}
const url = 'https://fixture.invalid/metadata'

afterEach(() => vi.unstubAllGlobals())

describe('local-only provider requests', () => {
  it('blocks the shared request without a worker in either runtime', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = createProviderRequest(plugin)
    const unavailable = {
      message: 'Provider requires a paired local worker',
      recorded: true,
    }
    await expect(request(url)).rejects.toMatchObject(unavailable)
    await expect(
      withProviderTransport(
        async () => null,
        () => request(url),
      ),
    ).rejects.toMatchObject(unavailable)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses the API path for direct requests even without a request budget', () => {
    expect(() => createDirectProviderRequest(plugin)).toThrow(
      'Direct requests are unavailable for local-only providers',
    )
  })
})

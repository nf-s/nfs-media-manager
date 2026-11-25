import { nanoid } from 'nanoid'
import type {
  JsonValue,
  MediaPluginTestContext,
  MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  DIRECT_PROVIDER_RESPONSE_SOURCE,
  ProviderResponseCaptureSchema,
} from '@repo/schemas/provider-response'
import { db } from '@/lib/db'
import { checksumJson } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { providerSnapshot } from '@/schemas/db'
import { createProviderRequest } from './provider-requests'

type Evidence = {
  snapshotId: string
  requestUrl: string | null
  status: number | null
  observedAt: Date
}

type InteractiveMediaRead = {
  mediaItemId: string
  plugin: MediaProviderPlugin
  secrets: Record<string, string>
  maxSlotWaitMs: number
  normalizedData?: Record<string, JsonValue>
}

/** Retain allowed responses on the item as they arrive, including failed reads. */
export async function readMediaProviderWithEvidence<T>(
  {
    mediaItemId,
    plugin,
    secrets,
    maxSlotWaitMs,
    normalizedData,
  }: InteractiveMediaRead,
  execute: (request: MediaPluginTestContext['request']) => Promise<T>,
) {
  const responses: Evidence[] = []
  const readId = nanoid()
  const provider = plugin.manifest.id
  const record = createProviderResponseRecorder(
    async (value) => {
      const capture = ProviderResponseCaptureSchema.parse(value)
      const snapshotId = nanoid()
      const observedAt = capture.response.receivedAt
        ? new Date(capture.response.receivedAt)
        : new Date()
      await db.insert(providerSnapshot).values({
        id: snapshotId,
        mediaItemId,
        provider,
        source: DIRECT_PROVIDER_RESPONSE_SOURCE,
        checksum: checksumJson(capture),
        payload: { ...capture, readId },
        normalizedData,
        createdAt: observedAt,
      })
      responses.push({
        snapshotId,
        requestUrl: capture.request.url,
        status: capture.response.status,
        observedAt,
      })
    },
    providerResponseSecretValues(secrets),
    plugin.sanitizeResponseCapture,
    plugin.sanitizeNativeJsonResponseCapture,
  )
  const request = createProviderRequest(plugin, undefined, {
    beginResponseCapture: record('media'),
    maxSlotWaitMs,
  })
  try {
    return { result: await execute(request), responses }
  } finally {
    record.assertStored()
  }
}

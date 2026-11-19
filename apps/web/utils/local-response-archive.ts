import { z } from 'zod'
import {
  MAX_LOCAL_PROVIDER_RESPONSE_BYTES,
  type ProviderResponseBody,
} from '@repo/schemas/provider-response-body'

const archive = z.object({
  version: z.literal(1),
  id: z.string(),
  retainedBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  redacted: z.boolean().optional(),
  text: z.string().max(MAX_LOCAL_PROVIDER_RESPONSE_BYTES),
})

export async function openLocalResponseArchive(
  file: Blob,
  receipt: Extract<ProviderResponseBody, { state: 'local' }>,
): Promise<Extract<ProviderResponseBody, { state: 'captured' }>> {
  if (file.size > receipt.retainedBytes * 6 + 4096)
    throw new Error('The file exceeds the expected archive size.')
  const record = archive.parse(JSON.parse(await file.text()))
  const bytes = new TextEncoder().encode(record.text)
  if (
    record.id !== receipt.reference ||
    bytes.length !== receipt.retainedBytes ||
    record.retainedBytes !== bytes.length
  )
    throw new Error('The archive belongs to another response.')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  if (hex !== record.sha256)
    throw new Error('The archive checksum does not match.')
  return { state: 'captured', text: record.text, redacted: record.redacted }
}

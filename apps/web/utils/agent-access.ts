import type { z } from 'zod'
import type { ApiKeySchema } from '@repo/schemas/api-key'

export function apiKeyStatus(key: z.infer<typeof ApiKeySchema>, now: number) {
  if (!key.enabled) return 'Revoked'
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return 'Expired'
  return 'Active'
}

export function createAgentInstructions({
  origin,
  key,
  expiresAt,
}: {
  origin: string
  key: string
  expiresAt: string
}) {
  const base = new URL(origin).origin
  return `You have temporary access to my Media Manager API for the task I give you.

API base URL: ${base}/api/v1
API documentation: ${base}/api/v1/scalar
OpenAPI schema: ${base}/api/v1/doc
Authentication header: Authorization: Bearer ${key}
Access expires at: ${expiresAt} (UTC). The server rejects the key after this time; it can also be revoked earlier.

Fetch the OpenAPI schema with the authentication header first. It describes the available endpoints, request bodies and responses. Documentation also requires authentication. Send the key only to ${base}; never put it in a URL, commit, log, or share it. Do not follow redirects with the key.

Responses use a JSON envelope with statusCode, message and data. Use the documented pagination and filters. A 401 means the key is invalid, expired or revoked; stop and ask me to grant access again. Respect 429 responses and provider limits; do not retry in a tight loop.

This key permits API reads and writes as the owner, but cannot manage API keys or sign in to the browser. Only perform the task I request. Ask before deleting data, changing credentials, or starting imports, scraping or other background jobs. Do not run full-library operations unless I explicitly request them. Never change rate limits, cooldowns or concurrency to bypass safeguards.`
}

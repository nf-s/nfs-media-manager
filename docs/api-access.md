# API access

Open **User** beside **Sign out** to manage API keys. Choose a name, expiry and rate limit, then copy the new key. The complete key is shown only once. The list shows its prefix, status, creation time, expiry, last use and rate limit. **Revoke** asks for confirmation and stops subsequent requests immediately.

**Grant Agent Access** creates a key that expires 60 minutes after creation and shows instructions to paste into an agent. The instructions include the API URL, authentication header, expiry and documentation links. Copying uses the browser clipboard; if clipboard access is blocked, select and copy the text manually. Closing the result or leaving the page discards the displayed key. Create another grant when access expires.

Keys allow API reads and writes as the current owner. Creating, listing, editing rate limits and revoking keys requires an owner browser session. Account connections, provider credential management, playback tokens and local-worker pairing also require browser sign-in. Provider request limits, cooldowns and job controls remain in effect.

## Requests and documentation

Use the public application origin and send the key in the `Authorization: Bearer <API_KEY>` header. Never place it in a URL. The API base path is `/api/v1`; successful responses contain `statusCode`, `message` and `data`.

**User → API documentation** opens the interactive reference at `/api/v1/scalar`. The OpenAPI schema is at `/api/v1/doc`. Both require an owner browser session or a valid API key and return private, non-cacheable responses. An agent should fetch the schema with its key before making requests.

The server checks expiry, revocation and the current owner account on each key-authenticated request. Invalid, expired and revoked keys receive HTTP 401.

By default a key allows 10,000 requests per hour. Set a different allowance from 1 to 1,000,000 requests and a window from 1 second to 24 hours, or select **Unlimited** for that key. A window starts with its first counted request. A new allowance applies immediately to requests already counted in the current window. A limited key at its allowance returns HTTP 429 with a `Retry-After` header. Editing a key's settings preserves its expiry and revocation status.

`POST /api/v1/user/api-keys` accepts an optional `rateLimit`. Submit the same object as `rateLimit` in `PATCH /api/v1/user/api-keys/{id}` to change a key's limit. Use `{"enabled":true,"maxRequests":500,"windowSeconds":3600}` for a limited key or `{"enabled":false}` for an unlimited key. Key metadata includes `rateLimit` and `requestsUsed`, the count in its current window. `requestsUsed` is `null` for unlimited keys.

## Implementation

API keys reuse the existing `apikey` table. Only a SHA-256 hash of each randomly generated key is stored, with a short display prefix. No additional deployment flag or database migration is required. Browser mutations retain their origin checks; authenticated non-browser requests may omit Origin. An explicit untrusted browser origin remains rejected.

# API access

Open **User** beside **Sign Out** to create and revoke API keys. Choose a name and expiry, then copy the new key. The complete key is shown only once; the list contains its prefix, status, creation time, expiry and last use. Revoking a key stops subsequent requests immediately.

**Grant Agent Access** creates a key that expires 60 minutes after creation and shows instructions to paste into an agent. The instructions include the API URL, authentication header, expiry and documentation links. Copying uses the browser clipboard; if clipboard access is blocked, select and copy the text manually. Closing the result or leaving the page discards the displayed key. Create another grant when access expires.

Keys allow API reads and writes as the current owner. Creating, listing and revoking keys requires a signed-in browser session; a key cannot create another key or a browser session. Account connections, provider credential management, playback tokens and local-worker pairing also require browser sign-in. Provider request limits, cooldowns and job controls remain in effect.

## Requests and documentation

Use the public application origin and send the key in the `Authorization: Bearer <API_KEY>` header. Never place it in a URL. The API base path is `/api/v1`; successful responses contain `statusCode`, `message` and `data`.

**User → API documentation** opens the interactive reference at `/api/v1/scalar`. The OpenAPI schema is at `/api/v1/doc`. Both require an owner browser session or a valid API key and return private, non-cacheable responses. An agent should fetch the schema with its key before making requests.

The server checks expiry, revocation and the current owner account on each key-authenticated request. Invalid, expired and revoked keys receive HTTP 401. Each key allows up to 10,000 requests in an hourly window; exceeding that returns HTTP 429 with a `Retry-After` header. This does not increase any provider's request allowance.

## Implementation

API keys reuse the existing `apikey` table. Only a SHA-256 hash of each randomly generated key is stored, with a short display prefix. No additional deployment flag or database migration is required. Browser mutations retain their origin checks; authenticated non-browser requests may omit Origin. An explicit untrusted browser origin remains rejected.

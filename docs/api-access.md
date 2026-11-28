# API access

Open **User** beside **Sign out** to manage API keys. Choose a name, expiry and rate limit, then copy the new key. The complete key is shown only once. The list shows its prefix, status, creation time, expiry, last use and rate limit. **Revoke** asks for confirmation and stops subsequent requests immediately.

**Grant Agent Access** creates a key that expires 60 minutes after creation and shows instructions to paste into an agent. The instructions include the API URL, authentication header, expiry and documentation links. Copying uses the browser clipboard; if clipboard access is blocked, select and copy the text manually. Closing the result or leaving the page discards the displayed key. Create another grant when access expires.

Keys allow API reads and writes as the current owner. Creating, listing, editing rate limits and revoking keys requires an owner browser session. Account connections, provider credential management, playback tokens and local-worker pairing also require browser sign-in. Provider request limits, cooldowns and job controls remain in effect.

## Requests and documentation

Use the public application origin and send the key in the `Authorization: Bearer <API_KEY>` header. Never place it in a URL. The API base path is `/api/v1`; successful responses contain `statusCode`, `message` and `data`.

**User → API documentation** opens the interactive reference at `/api/v1/scalar`. The OpenAPI schema is at `/api/v1/doc`. Both require an owner browser session or a valid API key and return private, non-cacheable responses. An agent should fetch the schema with its key before making requests.

The server checks expiry, revocation and the current owner account on each key-authenticated request. Invalid, expired and revoked keys receive HTTP 401.

By default a key allows 10,000 requests per hour. Set a different allowance from 1 to 1,000,000 requests and a window from 1 second to 24 hours, or select **Unlimited** for that key. A window starts with its first counted request. A new allowance applies immediately to requests already counted in the current window. A limited key at its allowance returns HTTP 429 with a `Retry-After` header. Editing a key's settings preserves its expiry and revocation status.

`POST /api/v1/user/api-keys` accepts an optional `rateLimit`. Submit the same object as `rateLimit` in `PATCH /api/v1/user/api-keys/{id}` to change a key's limit. Use `{"enabled":true,"maxRequests":500,"windowSeconds":3600}` for a limited key or `{"enabled":false}` for an unlimited key. Key metadata includes `rateLimit` and `requestsUsed`, the count in its current window. `requestsUsed` is `null` for unlimited keys. It also includes `kind`: `device` for a key issued by device pairing, otherwise `api`.

## Devices

A phone or desktop app signs in by pairing instead of copying a key.

1. In a signed-in browser, `POST /api/v1/device/pairings` returns a one-time `code` and its `expiresAt`, ten minutes later. It requires an owner browser session; an API key, including a device key, receives HTTP 403. Only a SHA-256 hash of the code is stored.
2. The device sends `POST /api/v1/device/pairings/exchange` with `{"code":"<code>","deviceName":"Phone"}`. It needs no session or key. The response contains `apiKey` (kind `device`, named after the device, with no expiry) and `key`, which is shown only once. A used, expired or unknown code receives HTTP 401. Each client address may make three exchange attempts per ten seconds in production; further attempts receive HTTP 429 with `Retry-After`.
3. The device sends the key as `Authorization: Bearer <key>`. A device key has the same access and rate limit as any API key: library reads and writes as the owner, and none of the routes that require a browser session.

Device keys appear in the User page key list and are revoked there or with `DELETE /api/v1/user/api-keys/{id}`, like any key. Revocation stops the device's requests immediately; pair again to restore access.

### Device feed

A device keeps a copy of the library by reading the feed described in [device store](requirements/device-store.md). The three routes accept an owner session or any API key, including a device key, and use the request and response schemas in `packages/schemas/src/device.ts`.

- `GET /api/v1/device/state` returns `ready` (false until the first complete build), `epoch`, `seq` (the highest committed sequence number), `minSeq` (the oldest sequence from which tombstones are held) and `rowVersion`.
- `GET /api/v1/device/snapshot?epoch=&entity=&after=&limit=` returns live rows of one entity with a sequence above `after`, in sequence order, as `{ reset: false, rows, seq, hasMore }`. Pass the returned `seq` as the next `after`.
- `GET /api/v1/device/changes?epoch=&since=&limit=` returns rows and tombstones of every entity with a sequence above `since`, in sequence order, as `{ reset: false, rows, seq, hasMore, pending }`. Marked rows are rendered first for up to two seconds; `pending` says marks remain, so more rows can follow.

`limit` is 1 to 2,000 rows (500 by default), and a page also stops before 4 MB of payload. A changed row returns with a new sequence number, so a row can appear twice in one snapshot; apply rows as upserts by entity and ID. Fill a device by reading the state, paging each entity's snapshot, then reading changes from the state's `seq`. Another `epoch`, a feed being rebuilt for a new `rowVersion`, or a `since` below `minSeq` answers `{ reset: true }`: start again from the state. Tombstones are kept for 90 days.

A native client that sends no `Origin`, `Referer` or `Sec-Fetch-*` header needs no further configuration. An app that runs in a web view on its own origin needs that origin in `DEVICE_ALLOWED_ORIGINS`, a comma-separated list without spaces (empty by default). For those origins only, routes under `/api/v1/device` answer CORS preflights for `GET`, `HEAD` and `POST`, allow the `Authorization` and `Content-Type` headers, and do not allow credentials, so cookies are never sent. The exchange accepts a request from those origins; every other mutation keeps the usual origin check, so other key-authenticated writes must come from a trusted origin or omit browser origin headers. With the setting empty, responses are unchanged.

## Implementation

API keys reuse the existing `apikey` table. Only a SHA-256 hash of each randomly generated key is stored, with a short display prefix. Migration `0079_device_pairing` adds the key `kind` (existing keys are `api`) and the `device_pairing` table of code hashes. Migration `0080_device_feed` adds the feed tables described in the [application architecture](handoff.md#device-feed). Browser mutations retain their origin checks; authenticated non-browser requests may omit Origin. An explicit untrusted browser origin remains rejected.

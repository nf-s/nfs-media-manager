# Web App

Next.js App Router with authenticated pages under `app/(admin)`, TanStack Query and shared UI primitives. The shared `MediaBrowser` owns filter/sort/view state, virtualized browsing and detail overlays. Album and film routes supply their media kind; provider metrics come from the API field descriptors.

Run `pnpm --filter web dev` from the workspace root. The dev launcher uses dotenv and the root `WEB_PORT`; no separate browser JSON configuration is needed. See the [root README](../../README.md), [UI guidelines](../../docs/dev-guidelines-ui.md) and [feature requirements](../../docs/requirements/README.md).

Spotify is an outbound link unless [playback](../../docs/spotify-playback.md) is connected in Providers; then the shell adds play controls and a player dock. Opening a page, changing a filter or viewing history must never trigger scraping, playback or remote playlist changes.

Jobs expose a compact **Stored JSON** disclosure for every outcome. Expanding it reads only that job's stored snapshots, diagnostics and legacy successful item payloads through the schema-validated `/api/v1/scrape/jobs/:id/data` endpoint. The viewer reuses `JsonTree`, polls every three seconds only while both disclosures are open and the job is queued/running, and reads again on status changes. Closing either disclosure stops polling and cancels an in-flight read. Missing historical failed responses are explicitly distinguished from empty search results. Viewing or reloading stored data never queues a retry or calls a provider.

Provider ratings share compact badges across poster overlays, the table Ratings column and Overview. Only explicit field `rating` descriptors identify public ratings; personal ratings and popularity remain separate. Film cards/rows show IMDb, Metascore, Letterboxd and runtime plugin ratings explicitly marked `compact: true`; Overview retains every available rating. Album RYM/Discogs/Metascore strips use the same alignment. Saved table columns still receive the Ratings strip. Real zero is preserved, missing scores use linked provider marks, and absent counts say unavailable. Hover, keyboard focus or tap exposes provider, score scale and full vote/review counts; Escape dismisses the tooltip before closing a detail modal. Tooltips use native popovers to avoid clipping in virtualized cells and native dialogs.

The detail rating strip accepts an optional trailer URL and shows a local YouTube logo linking to a validated HTTPS watch page. Film detail reads recover trailers from existing NFO/MDBList/TMDb current-state fields using one projected query, including legacy Kodi YouTube URLs. Cards/rows never show trailers. No video iframe, new scraping request, job, snapshot rewrite or historical backfill is involved. Missing/invalid trailers and non-YouTube links produce no trailer control. Generic YouTube service links are not assumed to be trailers.

The table rating-strip width counts only compact-enabled fields. Default film rows avoid a duplicate IMDb column; explicitly selected individual rating columns and card sort metrics remain numeric data, without adding provider badges outside the shared strip.

Public marks are vendored under `public/icons/ratings`, including the original Sonemic and Discogs images from the legacy app; plugin icons must be embedded raster data with a label fallback. No remote icon requests are made while browsing. Ratings are borderless icon-and-score pairs, with a single translucent strip on posters instead of wrapping boxed labels. Poster ratings always stack each icon above its score in a fixed-height translucent strip; absent scores use a dash. Grid density lives under Filters > Views. Metascore squares use movie/music thresholds: red below 40, yellow 40-60, green 61-100.

Run the dependency-free rating helper tests using the workspace's existing TypeScript runner:

```sh
apps/server/node_modules/.bin/tsx --test apps/web/utils/provider-ratings.test.ts
```

## Cloudflare Workers (Next.js 15)

The deployment uses [OpenNext Cloudflare](https://opennext.js.org/cloudflare/get-started), not Pages or the Edge runtime. Keep `next` on the supported 15.5 line. The web Worker is `nfs-media-manager`; `MEDIA_API` binds to the internal `nfs-media-api` Hono Worker. Browser `/api/*` requests and server session lookups both use that binding, never a public backend URL. The API Worker must have `workers_dev: false`, `preview_urls: false`, and no routes/custom domains.

Required package additions (managed at workspace level): `@opennextjs/cloudflare` and `wrangler`. Keep the existing `build` script as `next build`; add these web scripts:

```json
{
  "build:cloudflare": "node ./scripts/build-cloudflare.mjs",
  "preview:cloudflare": "pnpm run build:cloudflare && opennextjs-cloudflare preview",
  "check:cloudflare": "node ./scripts/check-cloudflare-build.mjs",
  "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
}
```

From `apps/web`, without deploying:

```sh
pnpm exec wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts
pnpm exec node scripts/build-cloudflare.mjs
pnpm exec wrangler deploy --dry-run
pnpm exec opennextjs-cloudflare preview
```

The Cloudflare build creates an isolated temporary workspace containing web sources, shared packages and copies of installed dependencies. It excludes `public/data`, `public/config.json`, public source maps, env files and old build output without modifying local inputs or the development `.next` directory. Source symlinks are rejected to prevent indirect inclusion of private files. Dependencies are copied rather than linked outside staging so OpenNext can trace and patch them correctly; this needs temporary disk space when filesystem cloning is unavailable. Staging is removed on success or failure. Only verified `.open-next` output is copied back, replacing stale artifacts; a failed build preserves the previous deployment output.

The output check rejects public source maps, dotenv files and private public inputs in the artifact independently of local source inputs. `.assetsignore` provides a second upload exclusion. Do not bypass the build wrapper when preparing a deployment. Root `.env`/`.env.local` are not loaded for Cloudflare builds; inherited application variables and secrets are also excluded from the build subprocess. The build origin comes from the caller-supplied `CLOUDFLARE_APP_URL`. No existing root env files need changing. The root `npm run build` remains the normal Node/Turbo build; the Cloudflare build is a separate command.

`wrangler.jsonc` supplies `WEB_RUNTIME=cloudflare`, `ASSETS`, `MEDIA_API` and `WORKER_SELF_REFERENCE`. It holds no account ID, origin or token: `pnpm deploy:cloudflare` requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_APP_URL` (an HTTPS origin such as `https://media.example`) in the caller's environment and passes the origin to Wrangler as `APP_URL`. Set the optional `CLOUDFLARE_WEB_ANALYTICS_TOKEN` to include the Cloudflare Web Analytics beacon; without it no analytics script is rendered. Change the service name consistently with the API deployment. Set the API's `APP_URL`, `AUTH_BASE_URL` and trusted origins to the public web origin; configure database/auth/provider secrets only on the API Worker, never as `NEXT_PUBLIC_*` variables. No R2/ISR/tag cache is configured for this private app. The Worker runs before assets, blocks private legacy paths/maps, and forces private/no-store headers on all responses except fingerprinted `/_next/static/*` assets. Keep Cloudflare cache rules from overriding those headers.

For local binding development, run the API's Wrangler dev process, then use `WEB_RUNTIME=cloudflare pnpm exec next dev` (also requires clean public inputs). For a production-runtime smoke test use OpenNext preview alongside the local API Worker. Normal `pnpm dev` retains the existing Node/dotenv behavior. Authenticated smoke tests should verify sign-in/sign-out, multiple Set-Cookie headers, redirects, session rejection and API owner authorization before deployment.

`AUTH_RATE_LIMITER` uses namespace `2026103001` with a threshold of 10 authentication attempts per IP per 60 seconds. Reserve that namespace for this app. The public Worker derives the key only from Cloudflare's `CF-Connecting-IP`, overwrites `x-media-client-ip` before Next.js, and the private API trusts only that dedicated header. Login, disabled signup and reset endpoints share the key; logout and session reads are exempt. Missing/failed bindings or missing/invalid connecting IPs fail closed with 503; exceeded limits return private/no-store 429 responses. Local Cloudflare preview must provide a valid connecting IP for login; ordinary Node development is unchanged. IPs are not logged by this guard or persisted in new auth sessions. Keep the API service private and do not attach untrusted service-binding callers.

Cloudflare's [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate and per location, not a strict global quota. Shared-IP clients share the allowance; distributed attempts can exceed it. Better Auth's in-memory limiter remains an additional per-isolate check. Logout cancels reads, clears query/mutation data, then performs a full document navigation to discard router and React state. Before deployment, test login throttling and logout against the built public Worker, not a direct Next.js server.

Focused checks from the workspace root:

```sh
node --test apps/web/scripts/*.test.mjs
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/utils/api-proxy.test.ts
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/utils/cloud-auth.test.ts apps/web/utils/logout.test.ts
pnpm --filter web typecheck
```

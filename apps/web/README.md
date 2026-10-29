# Web App

Next.js App Router with authenticated pages under `app/(admin)`, TanStack Query and shared UI primitives. The shared `MediaBrowser` owns filter/sort/view state, virtualized browsing and detail overlays. Album and film routes supply their media kind; provider metrics come from the API field descriptors.

Run `pnpm --filter web dev` from the workspace root. The dev launcher uses dotenv and the root `WEB_PORT`; no separate browser JSON configuration is needed. See the [root README](../../README.md), [UI guidelines](../../docs/dev-guidelines-ui.md) and [feature requirements](../../docs/requirements/README.md).

Spotify is an outbound link only. Opening a page, changing a filter or viewing history must never trigger scraping or remote playlist changes.

Jobs expose a compact **Stored JSON** disclosure for every outcome. Expanding it reads only that job's stored snapshots, diagnostics and legacy successful item payloads through the schema-validated `/api/v1/scrape/jobs/:id/data` endpoint. The viewer reuses `JsonTree`, polls every three seconds only while both disclosures are open and the job is queued/running, and reads again on status changes. Closing either disclosure stops polling and cancels an in-flight read. Missing historical failed responses are explicitly distinguished from empty search results. Viewing or reloading stored data never queues a retry or calls a provider.

Provider ratings share compact badges across poster overlays, the table Ratings column and Overview. Only explicit field `rating` descriptors identify public ratings; personal ratings and popularity remain separate. Film cards/rows show IMDb, Metascore, Letterboxd and runtime plugin ratings explicitly marked `compact: true`; Overview retains every available rating. Album RYM/Discogs/Metascore strips use the same alignment. Saved table columns still receive the Ratings strip. Real zero is preserved, missing scores use linked provider marks, and absent counts say unavailable. Hover, keyboard focus or tap exposes provider, score scale and full vote/review counts; Escape dismisses the tooltip before closing a detail modal. Tooltips use native popovers to avoid clipping in virtualized cells and native dialogs.

The detail rating strip accepts an optional trailer URL and shows a local YouTube logo linking to a validated HTTPS watch page. Film detail reads recover trailers from existing NFO/MDBList/TMDb current-state fields using one projected query, including legacy Kodi YouTube URLs. Cards/rows never show trailers. No video iframe, new scraping request, job, snapshot rewrite or historical backfill is involved. Missing/invalid trailers and non-YouTube links produce no trailer control. Generic YouTube service links are not assumed to be trailers.

The table rating-strip width counts only compact-enabled fields. Default film rows avoid a duplicate IMDb column; explicitly selected individual rating columns and card sort metrics remain numeric data, without adding provider badges outside the shared strip.

Public marks are vendored under `public/icons/ratings`, including the original Sonemic and Discogs images from the legacy app; plugin icons must be embedded raster data with a label fallback. No remote icon requests are made while browsing. Ratings are borderless icon-and-score pairs, with a single translucent strip on posters instead of wrapping boxed labels. Poster ratings always stack each icon above its score in a fixed-height translucent strip; absent scores use a dash. Grid density lives under Views. Metascore squares use movie/music thresholds: red below 40, yellow 40-60, green 61-100.

Run the dependency-free rating helper tests using the workspace's existing TypeScript runner:

```sh
apps/server/node_modules/.bin/tsx --test apps/web/utils/provider-ratings.test.ts
```

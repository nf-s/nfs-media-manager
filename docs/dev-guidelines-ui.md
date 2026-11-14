# UI Guidelines

## Stack

- `apps/web` uses `Next.js App Router`.
- Client-side data fetching goes through `TanStack Query`.
- Shared design primitives come from [`packages/ui/src/components/ui`](../packages/ui/src/components/ui).

## Page Pattern

- Protected pages live under the App Router admin layout.
- Use [`apps/web/components/page-auth-guard.tsx`](../apps/web/components/page-auth-guard.tsx) for server-side auth gating.
- Use [`apps/web/components/providers.tsx`](../apps/web/components/providers.tsx) for the shared query client and config context.
- Keep list state in URL search params when practical so views are shareable and recoverable.
- Use `SectionSidebar` and `SectionWorkspace` for secondary navigation, as in Jobs and Providers. Route destinations use links; in-page selections use buttons. Above 700px the sidebar is placed in the navigation rail under the main navigation (`useRailSlot`); on phones it is a scrolling segmented row above the content. Keep the shell bounded and scroll only the rail section/content regions. Jobs monitoring retains its own infinite-scroll region.
- The shell is a navigation rail beside one white content panel; on phones the rail becomes a top row (library, activity, sign out) and a bottom tab bar. Browse places its active filters in the rail above 700px. With Spotify playback connected, a player dock spans the bottom of the shell once something is played or queued, or while the account plays on another device; drawers end above it, and on phones it is a mini-player above the tab bar.

## Data Fetching

- Fetch server data through [`apps/web/utils/api.ts`](../apps/web/utils/api.ts) and validate responses with shared Zod schemas.
- Keep mutations in client components or dedicated hooks. Invalidate affected query keys after success.
- Do not store provider secrets in client state beyond transient form input.

## Interaction

- Browse pages must handle loading, empty, and populated states.
- Detail pages must expose history, provider references, overrides, and re-scrape actions.
- Job creation UI must remain conservative by default and clearly signal broad-run confirmation.

## Visual Direction

- Prefer compact, high-density browsing with high-contrast text and subtle dividers. Do not trade density for whitespace.
- Cool grey page (`--page`) with light grain, flat white panels, near-black text and slate accents. No green. Success is neutral slate, failure muted red, running/queued/needs-attention amber. Provider rating marks keep their own brand colours.
- Modest radii: panels 10–12px, controls 6–8px, artwork 4–6px, pills fully rounded. Hairline dividers (`--line`, `--line-soft`) instead of nested bordered cards.
- Use blur only on bars that content scrolls under, popovers and sheets. Never on repeated elements such as artwork overlays or on full-screen backdrops: it is slow in Firefox.
- No gradients, decorative banners or repeated administrative labels.
- Use shared buttons, inputs and other primitives. Do not wrap every group in a card.
- Keep grids artwork-first and tables compact. Keep search, sorting, sort direction, the layout switcher and result count in the browse toolbar. One Filters button opens a drawer from the right with collapsible Views, Smart playlists (albums), Ranges, Listening (albums) and Columns (table) sections. Active filter chips stay in the rail or mobile filter row.
- Open details without losing browse state or scroll: a drawer over the results from the right, and a bottom sheet on phones. Show useful information immediately; keep raw data in History and advanced controls in tabs/popovers.
- Grid artwork carries the ratings strip, the active sort value and optional tag pills (Filters > Views > On artwork). The strip is a light panel with rating scores in the monospace face; service links sit at its right and it scrolls sideways. A tile keeps a row under the byline only when the sort value or the strip is off the artwork. The filter drawer closes on Escape or an outside click and restores focus to its trigger. Remaining toolbar popovers open one at a time and close on Escape or an outside click.
- Use consistent metadata pills for clickable filters in detail pages and the inspector, including creators, source and watched status. Keep table/grid values compact without repeated filter icons; their filtering behavior and keyboard access must remain intact.

## Secondary tables

All tables outside Browse use the [secondary table pattern](secondary-tables.md): shared sortable data headers, a persistent Columns control and a rounded neutral scroll container. Sort raw values across the complete result set before pagination; only selection, artwork and action columns are exempt. Keep chosen columns accessible through horizontal scrolling on phones. The guide lists covered views, component responsibilities, date semantics and verification requirements. Browse tables retain their existing controls and layout.

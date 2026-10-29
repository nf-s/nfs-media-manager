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
- Use `SectionSidebar` and `SectionWorkspace` for secondary navigation, as in Jobs and Providers. Route destinations use links; in-page selections use buttons. Keep the shell bounded and scroll only the sidebar/content regions. Jobs monitoring retains its own infinite-scroll region.

## Data Fetching

- Fetch server data through [`apps/web/utils/api.ts`](../apps/web/utils/api.ts) and validate responses with shared Zod schemas.
- Keep mutations in client components or dedicated hooks. Invalidate affected query keys after success.
- Do not store provider secrets in client state beyond transient form input.

## Interaction

- Browse pages must handle loading, empty, and populated states.
- Detail pages must expose history, provider references, overrides, and re-scrape actions.
- Job creation UI must remain conservative by default and clearly signal broad-run confirmation.

## Visual Direction

- Prefer compact, high-density browsing with high-contrast text and subtle dividers.
- No gradients, decorative banners, rounded cards or repeated administrative labels. Rounded tag pills are appropriate.
- Use shared buttons, inputs and other primitives. Do not wrap every group in a card.
- Keep grids artwork-first and tables compact. Keep filters, sort and view controls together.
- Open details without losing browse state or scroll. Show useful information immediately; keep raw data in History and advanced controls in tabs/popovers.
- Use consistent metadata pills for clickable filters in detail pages and modals, including creators, source and watched status. Keep table/grid values compact without repeated filter icons; their filtering behavior and keyboard access must remain intact.

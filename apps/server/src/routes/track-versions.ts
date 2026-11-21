import type { OpenAPIHono } from '@hono/zod-openapi'
import { createOpenAPIApp, type AppEnv } from '@/lib/openapi'

/** Mounted at `/library-changes/track-versions`. */
export const trackVersionChanges: OpenAPIHono<AppEnv> = createOpenAPIApp()

/** Mounted at `/tracks`, before the tracks routes. */
export const trackParts: OpenAPIHono<AppEnv> = createOpenAPIApp()

/** Mounted at `/albums`, before the albums routes. */
export const albumUnlistedNames: OpenAPIHono<AppEnv> = createOpenAPIApp()

import type { OpenAPIHono } from '@hono/zod-openapi'
import { createOpenAPIApp, type AppEnv } from '@/lib/openapi'

/** Mounted at `/library-changes/track-separations`. */
export const trackSeparations: OpenAPIHono<AppEnv> = createOpenAPIApp()

/** Mounted at `/tracks`, before the tracks routes. */
export const trackDuplicates: OpenAPIHono<AppEnv> = createOpenAPIApp()

import type { OpenAPIHono } from '@hono/zod-openapi'
import { createOpenAPIApp, type AppEnv } from '@/lib/openapi'

/** Mounted at `/library-changes/artist-merges`. */
export const artistMerges: OpenAPIHono<AppEnv> = createOpenAPIApp()

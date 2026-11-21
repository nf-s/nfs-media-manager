import type { OpenAPIHono } from '@hono/zod-openapi'
import { createOpenAPIApp, type AppEnv } from '@/lib/openapi'

/** Mounted at `/library-changes/album-merges`. */
export const albumMerges: OpenAPIHono<AppEnv> = createOpenAPIApp()

/** Mounted at `/library-changes/album-names`. */
export const albumNames: OpenAPIHono<AppEnv> = createOpenAPIApp()

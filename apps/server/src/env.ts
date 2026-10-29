import { loadWorkspaceEnv } from '@/lib/load-workspace-env'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

loadWorkspaceEnv()

export const env = createEnv({
  shared: {
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
  },
  server: {
    APP_URL: z.url().default('http://localhost:3000'),
    AUTH_BASE_URL: z.url().optional(),
    INTERNAL_BACKEND_URL: z.url().optional(),
    DATABASE_URL: z
      .url()
      .refine(
        (value) =>
          ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
        {
          message: 'DATABASE_URL must use postgres:// or postgresql://',
        },
      )
      .optional(),
    DATABASE_SSL: z.enum(['disable', 'verify']).optional(),
    DATABASE_SCHEMA: z.string().optional(),
    DATABASE_HOST: z.string().default('localhost'),
    DATABASE_PORT: z.coerce.number().default(5431),
    DATABASE_USER: z.string().default('admin'),
    DATABASE_PASSWORD: z.string().default('admin'),
    DATABASE_NAME: z.string().default('media-manager-dev'),
    TRUSTED_ORIGINS: z
      .string()
      .default('http://localhost:3000,http://localhost:4000')
      .transform((val) => val.split(',')),
    DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND: z
      .string()
      .optional()
      .default('false')
      .transform((val) => val === 'true'),
    PORT: z.coerce.number().default(4000),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters long'),
    MEDIA_ENCRYPTION_KEY: z
      .string()
      .min(32, 'MEDIA_ENCRYPTION_KEY must be at least 32 characters long'),
    MEDIA_PLUGIN_PATHS: z
      .string()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      ),
    LEGACY_SERVER_DATA_DIR: z.string().default('apps/server/data'),
    LEGACY_WEB_DIST_DIR: z.string().default('apps/web/dist'),
    SCAN_DIR: z.string().optional(),
  },
  runtimeEnv: {
    APP_URL: process.env.APP_URL,
    AUTH_BASE_URL: process.env.AUTH_BASE_URL,
    INTERNAL_BACKEND_URL: process.env.INTERNAL_BACKEND_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SSL: process.env.DATABASE_SSL,
    DATABASE_SCHEMA: process.env.DATABASE_SCHEMA,
    DATABASE_HOST: process.env.DATABASE_HOST,
    DATABASE_PORT: process.env.DATABASE_PORT,
    DATABASE_USER: process.env.DATABASE_USER,
    DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
    DATABASE_NAME: process.env.DATABASE_NAME,
    TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS,
    DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND:
      process.env.DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND,
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    MEDIA_ENCRYPTION_KEY: process.env.MEDIA_ENCRYPTION_KEY,
    MEDIA_PLUGIN_PATHS: process.env.MEDIA_PLUGIN_PATHS,
    LEGACY_SERVER_DATA_DIR: process.env.LEGACY_SERVER_DATA_DIR,
    LEGACY_WEB_DIST_DIR: process.env.LEGACY_WEB_DIST_DIR,
    SCAN_DIR: process.env.SCAN_DIR,
  },
})

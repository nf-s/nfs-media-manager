import { z } from 'zod'

export const SpotifyAccountStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  scope: z.string().nullable(),
  redirectUri: z.string().nullable(),
})
export const SpotifyAuthorizeInputSchema = z.object({}).strict()
export const SpotifyAuthorizeResultSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
})
export const SpotifyCallbackSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(256).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error), {
    message: 'Expected an authorization code or denial',
  })
export const SpotifySavedAlbumsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(20),
    offset: z.number().int().min(0).max(10000).default(0),
    confirmBroadRun: z.boolean().default(false),
    scanAll: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.limit <= 50 || value.confirmBroadRun, {
    message: 'Confirm discovery of more than 50 saved albums',
    path: ['confirmBroadRun'],
  })
  .refine((value) => !value.scanAll || value.confirmBroadRun, {
    message: 'Confirm reading the saved library to find newest additions',
    path: ['confirmBroadRun'],
  })
  .refine((value) => !value.scanAll || value.offset === 0, {
    message:
      'Newest-added discovery must start at the beginning of the library',
    path: ['offset'],
  })
export const SpotifyDisconnectResultSchema = z.object({
  disconnected: z.literal(true),
})

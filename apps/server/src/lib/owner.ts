import { z } from 'zod'

type OwnerConfiguration = {
  NODE_ENV?: string
  OWNER_EMAIL?: string
  OWNER_USER_ID?: string
}

const OwnerEmailSchema = z.string().trim().toLowerCase().pipe(z.email())
const UserIdentitySchema = z.object({
  id: z.string().min(1),
  email: OwnerEmailSchema,
  role: z.string().nullish(),
})

export function assertOwnerConfiguration(config: OwnerConfiguration) {
  if (config.NODE_ENV === 'production' || config.OWNER_EMAIL !== undefined) {
    if (!OwnerEmailSchema.safeParse(config.OWNER_EMAIL).success) {
      throw new Error(
        'OWNER_EMAIL must be a valid email in production or when configured',
      )
    }
  }
  if (config.OWNER_USER_ID && !config.OWNER_EMAIL) {
    throw new Error('OWNER_USER_ID requires OWNER_EMAIL')
  }
}

export function isOwnerUser(
  user: unknown,
  config: OwnerConfiguration,
): boolean {
  const identity = UserIdentitySchema.safeParse(user)
  if (!identity.success) return false
  if (config.OWNER_EMAIL === undefined) {
    return config.NODE_ENV !== 'production' && !config.OWNER_USER_ID
  }
  const ownerEmail = OwnerEmailSchema.safeParse(config.OWNER_EMAIL)
  return (
    ownerEmail.success &&
    identity.data.email === ownerEmail.data &&
    identity.data.role === 'admin' &&
    (!config.OWNER_USER_ID || identity.data.id === config.OWNER_USER_ID)
  )
}

export function isMutationOriginAllowed(
  headers: Headers,
  config: OwnerConfiguration & { TRUSTED_ORIGINS: string[] },
): boolean {
  const origin = headers.get('origin')
  if (origin !== null) return config.TRUSTED_ORIGINS.includes(origin)

  const referer = headers.get('referer')
  if (referer !== null) {
    try {
      return config.TRUSTED_ORIGINS.includes(new URL(referer).origin)
    } catch {
      return false
    }
  }

  // Legacy local scripts omit browser headers. Owner deployments require an
  // explicit trusted Origin (or Referer), including for cookie-based CLI calls.
  return (
    config.NODE_ENV !== 'production' &&
    config.OWNER_EMAIL === undefined &&
    !headers.has('sec-fetch-site') &&
    !headers.has('sec-fetch-mode')
  )
}

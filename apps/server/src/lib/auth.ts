import { betterAuth, BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { db } from '@/lib/db'
import { assertOwnerConfiguration, isOwnerUser } from '@/lib/owner'

assertOwnerConfiguration(env)

const sessionResponseSchema = z.object({ user: z.unknown() })
const clientIpSchema = z.union([z.ipv4(), z.ipv6()])
const allowedAuthPaths = new Set([
  '/sign-in/email',
  '/sign-up/email', // Better Auth returns its explicit disabled-signup error.
  '/get-session',
  '/sign-out',
])

const authConfig = {
  appName: 'NFS Media Manager',
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.AUTH_BASE_URL ?? env.INTERNAL_BACKEND_URL ?? env.APP_URL,
  trustedOrigins: env.TRUSTED_ORIGINS,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },
  session: {
    cookieCache: { enabled: false },
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 12,
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    resetPasswordTokenExpiresIn: 60 * 60,
  },
  advanced: {
    useSecureCookies: env.NODE_ENV === 'production',
    ipAddress: {
      // Only the public web Worker may supply this header to the private service.
      ipAddressHeaders:
        env.RUNTIME_KIND === 'cloudflare'
          ? ['x-media-client-ip']
          : ['x-forwarded-for'],
    },
  },
  rateLimit: {
    enabled: env.NODE_ENV === 'production',
    storage: 'memory',
    customRules: {
      '/get-session': false,
      '/sign-out': false,
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!allowedAuthPaths.has(ctx.path)) {
        throw new APIError('FORBIDDEN', {
          message: 'Authentication endpoint is disabled',
        })
      }
      if (
        env.RUNTIME_KIND === 'cloudflare' &&
        (ctx.path === '/sign-in/email' || ctx.path === '/sign-up/email') &&
        !clientIpSchema.safeParse(ctx.headers?.get('x-media-client-ip')).success
      ) {
        throw new APIError('FORBIDDEN', {
          message: 'Trusted client address required',
        })
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/get-session' || ctx.context.returned === null) return
      const result = sessionResponseSchema.safeParse(ctx.context.returned)
      if (result.success && !isOwnerUser(result.data.user, env)) {
        throw new APIError('FORBIDDEN', { message: 'Forbidden' })
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        // Provision the initial owner offline with the seed script, never via auth.
        before: async () => false,
      },
      update: {
        before: async (user) => {
          if (user.email !== undefined || user.role !== undefined) {
            throw new APIError('FORBIDDEN', {
              message: 'Account identity is fixed',
            })
          }
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          if (!context) return false
          const user = await context.context.internalAdapter.findUserById(
            session.userId,
          )
          if (!isOwnerUser(user, env)) {
            throw new APIError('FORBIDDEN', { message: 'Forbidden' })
          }
          // IPs are transient rate-limit keys, never session profile data.
          return { data: { ...session, ipAddress: null } }
        },
      },
    },
  },
} satisfies BetterAuthOptions

export const auth = betterAuth(authConfig)

export type AuthType = {
  user: typeof auth.$Infer.Session.user | null
  session: typeof auth.$Infer.Session.session | null
}

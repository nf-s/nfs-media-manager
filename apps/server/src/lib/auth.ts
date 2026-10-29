import { betterAuth, BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { db } from '@/lib/db'

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
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },
  session: {
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
  },
} satisfies BetterAuthOptions

export const auth = betterAuth(authConfig)

export type AuthType = {
  user: typeof auth.$Infer.Session.user | null
  session: typeof auth.$Infer.Session.session | null
}

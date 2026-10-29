import { describe, expect, it, vi } from 'vitest'

vi.mock('@/env', () => ({
  env: {
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'offline-auth-test-secret-that-is-long-enough',
    AUTH_BASE_URL: 'http://localhost:4000',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
  },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: () => undefined,
}))

import { auth } from './auth'

describe('private admin authentication', () => {
  it('rejects anonymous email registration without creating a user', async () => {
    const response = await auth.handler(
      new Request('http://localhost:4000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'uninvited@example.com',
          name: 'Uninvited user',
          password: 'offline-fixture-password',
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    })
    const context = await auth.$context
    expect(
      await context.internalAdapter.findUserByEmail('uninvited@example.com'),
    ).toBeNull()
  })

  it('continues to sign in an administrator provisioned outside registration', async () => {
    const context = await auth.$context
    const user = await context.internalAdapter.createUser(
      {
        name: 'Seeded administrator',
        email: 'administrator@example.com',
        emailVerified: true,
        role: 'admin',
      },
      { method: 'admin' },
    )
    await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: await context.password.hash('offline-admin-password'),
    })

    const response = await auth.handler(
      new Request('http://localhost:4000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          password: 'offline-admin-password',
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: user.id, role: 'admin' },
    })
    expect(response.headers.get('set-cookie')).toContain('session_token=')
  })
})

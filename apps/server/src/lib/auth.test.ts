import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const env: {
    NODE_ENV: string
    OWNER_EMAIL?: string
    OWNER_USER_ID?: string
    BETTER_AUTH_SECRET: string
    AUTH_BASE_URL: string
    TRUSTED_ORIGINS: string[]
  } = {
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'offline-auth-test-secret-that-is-long-enough',
    AUTH_BASE_URL: 'http://localhost:4000',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
  }
  return { env }
})
vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: () => undefined,
}))

import { auth } from './auth'
import app from '@/app'

beforeEach(() => {
  mocks.env.OWNER_EMAIL = undefined
  mocks.env.OWNER_USER_ID = undefined
})

async function provisionUser(email: string, role = 'admin') {
  const context = await auth.$context
  const user = {
    id: crypto.randomUUID(),
    name: 'Seeded administrator',
    email,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  await context.adapter.create({
    model: 'user',
    data: user,
    forceAllowId: true,
  })
  await context.internalAdapter.createAccount({
    userId: user.id,
    accountId: user.id,
    providerId: 'credential',
    password: await context.password.hash('offline-admin-password'),
  })
  return user
}

function signIn(email: string) {
  return auth.handler(
    new Request('http://localhost:4000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'offline-admin-password' }),
    }),
  )
}

function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

describe('private admin authentication', () => {
  it('blocks registration but permits same-origin owner logout through the app', async () => {
    const user = await provisionUser('logout-owner@example.com')
    mocks.env.OWNER_EMAIL = user.email
    const headers = {
      'Content-Type': 'application/json',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    }
    const registration = await app.request(
      'http://localhost:3000/api/auth/sign-up/email',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'extra-app-user@example.com',
          name: 'Extra user',
          password: 'offline-fixture-password',
        }),
      },
    )
    expect(registration.status).toBe(400)
    expect(await registration.json()).toMatchObject({
      code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    })
    const context = await auth.$context
    expect(
      await context.internalAdapter.findUserByEmail(
        'extra-app-user@example.com',
      ),
    ).toBeNull()

    const login = await app.request(
      'http://localhost:3000/api/auth/sign-in/email',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: user.email,
          password: 'offline-admin-password',
        }),
      },
    )
    expect(login.status).toBe(200)
    const cookie = sessionCookies(login)
    const hostileLogout = await app.request(
      'http://localhost:3000/api/auth/sign-out',
      {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://evil.invalid',
          'sec-fetch-site': 'cross-site',
        },
      },
    )
    expect(hostileLogout.status).toBe(403)
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toMatchObject({ user: { id: user.id } })

    const logout = await app.request(
      'http://localhost:3000/api/auth/sign-out',
      {
        method: 'POST',
        headers: { ...headers, cookie },
      },
    )
    expect(logout.status).toBe(200)
    expect(logout.headers.get('cache-control')).toContain('no-store')
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull()
  })

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
    const user = await provisionUser('administrator@example.com')
    const response = await signIn(user.email)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: user.id, role: 'admin' },
    })
    expect(response.headers.get('set-cookie')).toContain('session_token=')
    const current = await auth.api.getSession({
      headers: new Headers({ cookie: sessionCookies(response) }),
    })
    expect(current?.session.ipAddress).toBeNull()
  })

  it('permits the configured owner to sign in and read the session', async () => {
    const user = await provisionUser('owner@example.com')
    mocks.env.OWNER_EMAIL = ' OWNER@EXAMPLE.COM '
    mocks.env.OWNER_USER_ID = user.id
    const response = await signIn(user.email)
    expect(response.status).toBe(200)
    const session = await auth.handler(
      new Request('http://localhost:4000/api/auth/get-session', {
        headers: { cookie: sessionCookies(response) },
      }),
    )
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { id: user.id } })
  })

  it.each([
    { email: 'another-admin@example.com', role: 'admin', pinnedId: undefined },
    { email: 'not-admin@example.com', role: 'user', pinnedId: undefined },
    { email: 'wrong-id@example.com', role: 'admin', pinnedId: 'different-id' },
  ])(
    'refuses a new non-owner session: $email',
    async ({ email, role, pinnedId }) => {
      const user = await provisionUser(email, role)
      mocks.env.OWNER_EMAIL =
        email === 'another-admin@example.com' ? 'owner@example.com' : email
      mocks.env.OWNER_USER_ID = pinnedId
      const response = await signIn(user.email)
      expect(response.status).toBe(403)
      expect(response.headers.get('set-cookie')).toBeNull()
    },
  )

  it('rejects previously issued non-owner sessions through HTTP and the server API', async () => {
    const user = await provisionUser('previous-admin@example.com')
    const response = await signIn(user.email)
    expect(response.status).toBe(200)
    const headers = new Headers({ cookie: sessionCookies(response) })
    mocks.env.OWNER_EMAIL = 'owner@example.com'
    const current = await auth.handler(
      new Request('http://localhost:4000/api/auth/get-session', { headers }),
    )
    expect(current.status).toBe(403)
    await expect(auth.api.getSession({ headers })).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    const signOut = await auth.handler(
      new Request('http://localhost:4000/api/auth/sign-out', {
        method: 'POST',
        headers: {
          cookie: sessionCookies(response),
          origin: 'http://localhost:3000',
        },
      }),
    )
    expect(signOut.status).toBe(200)
  })

  it('checks the current database role rather than a cached owner cookie', async () => {
    const user = await provisionUser('revoked-role@example.com')
    mocks.env.OWNER_EMAIL = user.email
    const response = await signIn(user.email)
    expect(response.status).toBe(200)
    const context = await auth.$context
    await context.adapter.update({
      model: 'user',
      where: [{ field: 'id', value: user.id }],
      update: { role: 'user' },
    })
    const current = await auth.handler(
      new Request('http://localhost:4000/api/auth/get-session', {
        headers: { cookie: sessionCookies(response) },
      }),
    )
    expect(current.status).toBe(403)
  })

  it.each([
    '/change-email',
    '/update-user',
    '/verify-email',
    '/sign-in/social',
    '/delete-user',
    '/link-social',
  ])('blocks the unused account-management endpoint %s', async (path) => {
    const response = await auth.handler(
      new Request(`http://localhost:4000/api/auth${path}`, {
        method: path === '/verify-email' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:
          path === '/verify-email'
            ? undefined
            : JSON.stringify({ newEmail: 'other@example.com' }),
      }),
    )
    expect(response.status).toBe(403)
  })

  it('prevents auth adapter user creation and identity changes as defense in depth', async () => {
    const context = await auth.$context
    const user = await provisionUser('fixed-owner@example.com')
    expect(
      await context.internalAdapter.createUser(
        {
          name: 'Extra user',
          email: 'extra@example.com',
          emailVerified: true,
        },
        { method: 'admin' },
      ),
    ).toBeNull()
    await expect(
      context.internalAdapter.updateUser(user.id, {
        email: 'changed@example.com',
      }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' })
    await expect(
      context.internalAdapter.updateUser(user.id, { role: 'user' }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' })
    expect(await context.internalAdapter.findUserById(user.id)).toMatchObject({
      email: user.email,
      role: 'admin',
    })
  })
})

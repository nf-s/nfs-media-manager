import { describe, expect, it, vi } from 'vitest'

vi.mock('@/env', () => ({
  env: {
    NODE_ENV: 'production',
    RUNTIME_KIND: 'cloudflare',
    OWNER_EMAIL: 'owner@example.com',
    BETTER_AUTH_SECRET: 'offline-cloud-auth-test-secret-that-is-long-enough',
    AUTH_BASE_URL: 'https://media.example',
    TRUSTED_ORIGINS: ['https://media.example'],
  },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: () => undefined,
}))

import { auth } from './auth'

const appUrl = 'https://media.example'

function signIn(
  headers: Record<string, string>,
  email = 'missing@example.com',
) {
  return auth.handler(
    new Request(`${appUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        ...headers,
        origin: appUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password: 'offline-owner-password' }),
    }),
  )
}

describe('private Cloudflare auth boundary', () => {
  it('trusts only the wrapper header, with ephemeral rate-limit storage', async () => {
    const context = await auth.$context
    expect(context.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      'x-media-client-ip',
    ])
    expect(context.options.rateLimit?.storage).toBe('memory')
    const response = await signIn({
      'x-forwarded-for': '192.0.2.10',
      'cf-connecting-ip': '192.0.2.10',
      'x-real-ip': '192.0.2.10',
    })
    expect(response.status).toBe(403)
    const invalid = await signIn({
      'x-media-client-ip': '192.0.2.10, 192.0.2.11',
    })
    expect(invalid.status).toBe(403)
  })

  it('keeps different verified client IPs in separate login buckets', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await signIn({ 'x-media-client-ip': '192.0.2.20' })
      expect(response.status).toBe(401)
    }
    const limited = await signIn({ 'x-media-client-ip': '192.0.2.20' })
    expect(limited.status).toBe(429)
    const separate = await signIn({ 'x-media-client-ip': '198.51.100.20' })
    expect(separate.status).toBe(401)
  })

  it('issues host-only secure cookies without storing IPs and permits logout without an IP', async () => {
    const context = await auth.$context
    const user = {
      id: crypto.randomUUID(),
      name: 'Owner',
      email: 'owner@example.com',
      emailVerified: true,
      role: 'admin',
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
      password: await context.password.hash('offline-owner-password'),
    })
    const response = await signIn(
      { 'x-media-client-ip': '192.0.2.30' },
      user.email,
    )
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie()
    const sessionCookie = cookies.find((value) =>
      value.startsWith('__Secure-better-auth.session_token='),
    )
    expect(sessionCookie).toBeDefined()
    expect(sessionCookie).toContain('Secure')
    expect(sessionCookie).toContain('HttpOnly')
    expect(sessionCookie).toMatch(/SameSite=Lax/i)
    expect(sessionCookie).not.toMatch(/Domain=/i)
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    })
    expect(session?.user.id).toBe(user.id)
    expect(session?.session.ipAddress).toBeNull()
    const stored = await context.adapter.findMany({
      model: 'session',
      where: [{ field: 'userId', value: user.id }],
    })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ ipAddress: null })

    const lookup = await auth.handler(
      new Request(`${appUrl}/api/auth/get-session`, { headers: { cookie } }),
    )
    expect(lookup.status).toBe(200)
    const logout = await auth.handler(
      new Request(`${appUrl}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie, origin: appUrl },
      }),
    )
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull()
  })
})

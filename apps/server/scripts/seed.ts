import { eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@/schemas/db'
import { env } from '@/env'
import { getDatabaseConnectionOptions } from '@/lib/database-config'

function getRequiredEnvValue(
  value: string | undefined,
  message: string,
): string {
  if (!value) {
    throw new Error(message)
  }

  return value
}

async function main(): Promise<void> {
  const client = new pg.Client(getDatabaseConnectionOptions(env))

  await client.connect()

  try {
    const seedDb = drizzle(client, { schema })
    const email = getRequiredEnvValue(
      process.env.INITIAL_USER_EMAIL,
      'INITIAL_USER_EMAIL is required',
    )
    const name = getRequiredEnvValue(
      process.env.INITIAL_USER_NAME,
      'INITIAL_USER_NAME is required',
    )
    const password = getRequiredEnvValue(
      process.env.INITIAL_USER_PASSWORD,
      'INITIAL_USER_PASSWORD is required',
    )

    const existingUser = await seedDb.query.user.findFirst({
      where: (table, operators) => operators.eq(table.email, email),
    })

    if (existingUser) {
      console.info('Initial admin already exists. Skipping seed.')
      return
    }

    const userId = 'initial-admin'

    await seedDb.insert(schema.user).values({
      id: userId,
      email,
      name,
      emailVerified: true,
      role: 'admin',
    })

    await seedDb.insert(schema.account).values({
      id: 'initial-admin-account',
      userId,
      providerId: 'credential',
      accountId: userId,
      password: await hashPassword(password),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await seedDb
      .update(schema.user)
      .set({
        role: 'admin',
      })
      .where(eq(schema.user.id, userId))

    console.info('Initial admin user created.')
  } finally {
    await client.end()
  }
}

void main()

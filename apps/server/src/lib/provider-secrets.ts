import { decryptSecretValue } from '@/lib/crypto'
import { providerSecret } from '@/schemas/db'
import type { PluginSecretDescriptor } from '@repo/media-plugin-sdk'

type ProviderSecretRow = typeof providerSecret.$inferSelect

const providerSecretEnvFallbacks: Record<string, Record<string, string[]>> = {
  spotify: {
    clientId: ['SPOTIFY_CLIENT_ID'],
    clientSecret: ['SPOTIFY_CLIENT_SECRET'],
  },
  musicbrainz: {
    appName: ['MB_APP_NAME'],
    appVersion: ['MB_APP_VERSION'],
    contact: ['MB_CONTACT'],
  },
  discogs: {
    token: ['DISCOGS_TOKEN'],
  },
  lastfm: {
    apiKey: ['LASTFM_API_KEY'],
    username: ['LASTFM_USERNAME'],
  },
  tmdb: {
    apiKey: ['TMDB_API_KEY'],
  },
  omdb: {
    apiKey: ['OMDB_API_KEY'],
  },
}

function findConfiguredEnvValue(
  providerId: string,
  secretKey: string,
  descriptors: PluginSecretDescriptor[] = [],
): string | null {
  const fallbackKeys =
    descriptors.find((field) => field.key === secretKey)?.envVars ??
    providerSecretEnvFallbacks[providerId]?.[secretKey] ??
    []

  for (const envKey of fallbackKeys) {
    const value = process.env[envKey]

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

export function isProviderSecretConfigured(
  providerId: string,
  secretKey: string,
  rows: ProviderSecretRow[],
  descriptors: PluginSecretDescriptor[] = [],
): boolean {
  return (
    rows.some((row) => row.key === secretKey) ||
    findConfiguredEnvValue(providerId, secretKey, descriptors) !== null
  )
}

export function resolveProviderSecrets(
  providerId: string,
  rows: ProviderSecretRow[],
  descriptors: PluginSecretDescriptor[] = [],
): Record<string, string> {
  const secrets = Object.fromEntries(
    rows.map((row) => [row.key, decryptSecretValue(row.encryptedValue)]),
  )

  const fallbackKeys = new Set([
    ...Object.keys(providerSecretEnvFallbacks[providerId] ?? {}),
    ...descriptors.map((field) => field.key),
  ])

  for (const secretKey of fallbackKeys) {
    if (
      typeof secrets[secretKey] === 'string' &&
      secrets[secretKey].length > 0
    ) {
      continue
    }

    const envValue = findConfiguredEnvValue(providerId, secretKey, descriptors)

    if (envValue) {
      secrets[secretKey] = envValue
    }
  }

  return secrets
}

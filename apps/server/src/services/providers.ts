import { eq } from 'drizzle-orm'
import {
  ProviderRequestBudgetSchema,
  type ProviderRequestBudget,
  type ProviderSecrets,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { encryptSecretValue } from '@/lib/crypto'
import { createStableId } from '@/lib/media-utils'
import { listProviderCatalog, getScrapePlugin } from '@/plugins/registry'
import { db } from '@/lib/db'
import {
  isProviderSecretConfigured,
  resolveProviderSecrets,
} from '@/lib/provider-secrets'
import { providerSecret, providerRequestState } from '@/schemas/db'
import { ServerError } from '@/lib/error'
import { FAILURE_COOLDOWN_MS } from '@/lib/request-policy'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  clearProviderAccessHalt,
  createProviderRequest,
  getProviderSafety,
  recordProviderFailure,
  recordProviderSuccess,
  getProviderBudgetStatus,
} from '@/services/provider-requests'

export async function updateProviderBudget(
  providerId: string,
  input: ProviderRequestBudget,
  userId: string | null,
) {
  const budget = ProviderRequestBudgetSchema.parse(input)
  const provider = (await listProviderCatalog()).find(
    (item) => item.id === providerId,
  )
  if (!provider)
    throw new ServerError({ statusCode: 404, message: 'Provider not found' })
  if (!provider.rateLimit.configurableRequestBudget)
    throw new ServerError({
      statusCode: 422,
      message: 'This provider has fixed request limits',
    })
  await db.transaction(async (tx) => {
    await tx
      .insert(providerRequestState)
      .values({ provider: providerId })
      .onConflictDoNothing()
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, providerId))
      .for('update')
    // Earlier versions persisted the local hourly budget as a cooldown. Its
    // exact internal reason is distinct from HTTP/quota errors; never clear those.
    const obsoleteHourlyWait =
      budget.period === 'day' &&
      provider.rateLimit.maxRequestsPerHour === undefined &&
      state?.lastError === 'Hourly request budget exhausted' &&
      !state.halted
    await tx
      .update(providerRequestState)
      .set({
        requestBudgetOverride: budget,
        budgetUpdatedByUserId: userId,
        updatedAt: new Date(),
        ...(obsoleteHourlyWait ? { cooldownUntil: null, lastError: null } : {}),
      })
      .where(eq(providerRequestState.provider, providerId))
  })
  const status = await getProviderBudgetStatus(providerId, provider.rateLimit)
  if (!status) throw new Error('Missing configured provider budget')
  return status
}

async function getSecretRows(providerId: string) {
  return db.query.providerSecret.findMany({
    where: (table, operators) => operators.eq(table.provider, providerId),
  })
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const catalog = await listProviderCatalog()

  return Promise.all(
    catalog.map(async (provider) => {
      const secretRows = await getSecretRows(provider.id)
      const plugin = await getScrapePlugin(provider.id)
      const budgetStatus = await getProviderBudgetStatus(
        provider.id,
        provider.rateLimit,
      )

      return {
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        surface: provider.surface,
        mediaTypes: provider.mediaTypes,
        rateLimit: {
          ...provider.rateLimit,
          ...(budgetStatus ? { requestBudget: budgetStatus.budget } : {}),
          rateLimitCooldownMs: provider.rateLimit.rateLimitCooldownMs ?? 60000,
          errorBackoffMs: provider.rateLimit.errorBackoffMs ?? 60000,
          failureCooldownMs:
            provider.rateLimit.failureCooldownMs ?? FAILURE_COOLDOWN_MS,
        },
        reviewableErrors: provider.reviewableErrors ?? [],
        fileImports: provider.fileImports ?? [],
        browseFields: provider.browseFields ?? [],
        credentialEnvironment: provider.secrets.map((field) => ({
          key: field.key,
          envVars: field.envVars ?? [],
        })),
        supportsTestConnection: !!plugin?.testConnection,
        maxItemsPerJob: provider.maxItemsPerJob,
        requireExplicitSelection: provider.requireExplicitSelection,
        identifierTypes: provider.identifierTypes ?? [],
        supportsNameLookup: provider.supportsNameLookup ?? false,
        safety: await getProviderSafety(provider.id),
        budgetStatus,
        supportsScrape: provider.supportsScrape,
        supportsSync: false,
        connection: null,
        supportsLegacyImport: provider.supportsLegacyImport,
        pluginPath: provider.pluginPath,
        secrets: provider.secrets.map((field) => ({
          key: field.key,
          label: field.label,
          required: field.required,
          configured: isProviderSecretConfigured(
            provider.id,
            field.key,
            secretRows,
            provider.secrets,
          ),
          helpText: field.helpText ?? null,
          placeholder: field.placeholder ?? null,
        })),
      }
    }),
  )
}

export async function getProviderSecrets(
  providerId: string,
): Promise<ProviderSecrets> {
  const provider = (await listProviderCatalog()).find(
    (item) => item.id === providerId,
  )

  if (!provider) {
    throw new ServerError({
      statusCode: 404,
      message: 'Provider not found',
      description: `No provider is registered for "${providerId}".`,
    })
  }

  const secretRows = await getSecretRows(providerId)

  return {
    provider: providerId,
    fields: provider.secrets.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      configured: isProviderSecretConfigured(
        provider.id,
        field.key,
        secretRows,
        provider.secrets,
      ),
      helpText: field.helpText ?? null,
      placeholder: field.placeholder ?? null,
    })),
    lastVerifiedAt:
      secretRows
        .find((row) => row.lastVerifiedAt)
        ?.lastVerifiedAt?.toISOString() ?? null,
    lastVerifiedStatus:
      secretRows.find((row) => row.lastVerifiedStatus)?.lastVerifiedStatus ??
      null,
  }
}

export async function updateProviderSecrets(
  providerId: string,
  values: Record<string, string>,
  userId: string | null,
): Promise<ProviderSecrets> {
  const provider = (await listProviderCatalog()).find(
    (item) => item.id === providerId,
  )

  if (!provider) {
    throw new ServerError({
      statusCode: 404,
      message: 'Provider not found',
      description: `No provider is registered for "${providerId}".`,
    })
  }

  const entries = Object.entries(values)
  if (
    entries.some(
      ([key, value]) =>
        !provider.secrets.some((field) => field.key === key) || !value.trim(),
    )
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Unknown or empty credential',
    })
  for (const [key, value] of entries) {
    const existing = await db.query.providerSecret.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.provider, providerId),
          operators.eq(table.key, key),
        ),
    })

    if (existing) {
      await db
        .update(providerSecret)
        .set({
          encryptedValue: encryptSecretValue(value),
          lastUpdatedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(providerSecret.id, existing.id))
    } else {
      await db.insert(providerSecret).values({
        id: createStableId('secret', `${providerId}:${key}`),
        provider: providerId,
        key,
        encryptedValue: encryptSecretValue(value),
        lastUpdatedByUserId: userId,
      })
    }
  }

  if (entries.length) await clearProviderAccessHalt(providerId)
  return getProviderSecrets(providerId)
}

export async function testProviderSecrets(
  providerId: string,
): Promise<ProviderSecrets> {
  const provider = (await listProviderCatalog()).find(
    (item) => item.id === providerId,
  )

  if (!provider) {
    throw new ServerError({
      statusCode: 404,
      message: 'Provider not found',
    })
  }

  const rows = await getSecretRows(providerId)
  const secrets = resolveProviderSecrets(providerId, rows, provider.secrets)

  const missingRequiredSecrets = provider.secrets.filter(
    (field) => field.required && typeof secrets[field.key] !== 'string',
  )

  if (missingRequiredSecrets.length > 0) {
    await db
      .update(providerSecret)
      .set({
        lastVerifiedAt: new Date(),
        lastVerifiedStatus: 'missing-required-secrets',
      })
      .where(eq(providerSecret.provider, providerId))

    throw new ServerError({
      statusCode: 422,
      message: 'Provider secrets are incomplete',
      description: `Missing required secrets for ${provider.displayName}.`,
    })
  }

  const plugin = await getScrapePlugin(providerId)

  if (!plugin?.testConnection) {
    return {
      ...(await getProviderSecrets(providerId)),
      lastVerifiedStatus: 'Configured; remote verification is not supported',
    }
  }

  if (plugin?.testConnection) {
    try {
      await plugin.testConnection({
        secrets,
        request: createProviderRequest(plugin),
      })
      await recordProviderSuccess(providerId)
    } catch (error) {
      await recordProviderFailure(plugin, error)
      throw new ServerError({
        statusCode: 422,
        message:
          error instanceof ProviderRequestError
            ? error.message
            : 'Provider connection failed. No retry attempted.',
      })
    }
  }

  await db
    .update(providerSecret)
    .set({
      lastVerifiedAt: new Date(),
      lastVerifiedStatus: 'ok',
    })
    .where(eq(providerSecret.provider, providerId))

  return getProviderSecrets(providerId)
}

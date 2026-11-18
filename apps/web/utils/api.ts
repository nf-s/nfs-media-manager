import { z } from 'zod'
import { SONOS_PAGE_HEADER } from '@repo/schemas/sonos'
import { playerClientId } from './player-client'

let sonosPage: string | undefined

function sonosPageHeaders(path: string): Record<string, string> {
  if (
    (!path.startsWith('/api/v1/sonos/') &&
      path !== '/api/v1/playback/session') ||
    typeof document === 'undefined' ||
    typeof globalThis.crypto?.randomUUID !== 'function'
  )
    return {}
  sonosPage ??= playerClientId()
  return { [SONOS_PAGE_HEADER]: `${sonosPage}/${document.visibilityState}` }
}

type ApiRequestInit = RequestInit & {
  errorData?: { status: number; schema: z.ZodType }
}

function createEnvelopeSchema<TSchema extends z.ZodTypeAny>(
  dataSchema: TSchema,
) {
  return z.object({
    statusCode: z.number().int(),
    message: z.string(),
    data: z.unknown(),
  })
}

export async function fetchApiData<TSchema extends z.ZodTypeAny>(
  apiBaseUrl: string,
  path: string,
  dataSchema: TSchema,
  { errorData, ...init }: ApiRequestInit = {},
): Promise<z.infer<TSchema>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...sonosPageHeaders(path),
      ...(init?.headers ?? {}),
    },
  })

  const json = await response.json()

  if (!response.ok) {
    const errorSchema = z.object({
      statusCode: z.number().int().optional(),
      message: z.string().optional(),
      description: z.string().nullable().optional(),
      data: z.unknown().optional(),
    })
    const parsedError = errorSchema.safeParse(json)

    if (parsedError.success) {
      const { data, ...error } = parsedError.data
      const details =
        errorData?.status === response.status &&
        error.statusCode === response.status
          ? errorData.schema.safeParse(data)
          : undefined
      throw details?.success ? { ...error, data: details.data } : error
    }

    throw new Error('Request failed')
  }

  const envelope = createEnvelopeSchema(dataSchema).parse(json)

  return dataSchema.parse(envelope.data)
}

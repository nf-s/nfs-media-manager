import { z } from 'zod'
import { SONOS_PAGE_HEADER } from '@repo/schemas/sonos'
import { playerClientId } from './player-client'
import { changesLibraryRows, deviceSeam } from './device-store/seam'

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
  /** Called once the data is in: from the copy in this browser or from the API (DEVICE-46). */
  onAnswer?: (source: ApiAnswerSource) => void
}

export type ApiAnswerSource = 'device' | 'api'

function methodOf(init: RequestInit) {
  return (init.method ?? 'GET').toUpperCase()
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
  { errorData, onAnswer, ...init }: ApiRequestInit = {},
): Promise<z.infer<TSchema>> {
  const device = deviceSeam()
  const method = methodOf(init)
  if (device && method === 'GET' && init.body == null) {
    const local = await device.read(path, init.signal)
    // An answer the caller's schema rejects is a store fault: the API answers.
    const parsed = local ? dataSchema.safeParse(local.data) : undefined
    if (parsed?.success) {
      onAnswer?.('device')
      return parsed.data
    }
  }
  const settle =
    device && method !== 'GET' && method !== 'HEAD' && changesLibraryRows(path)
      ? device.beginWrite(path)
      : undefined
  try {
    return await requestApiData(apiBaseUrl, path, dataSchema, errorData, init, {
      onAnswer,
      unauthorized: device ? () => device.unauthorized() : undefined,
    })
  } finally {
    settle?.()
  }
}

async function requestApiData<TSchema extends z.ZodTypeAny>(
  apiBaseUrl: string,
  path: string,
  dataSchema: TSchema,
  errorData: ApiRequestInit['errorData'],
  init: RequestInit,
  {
    onAnswer,
    unauthorized,
  }: { onAnswer?: ApiRequestInit['onAnswer']; unauthorized?: () => void },
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

  if (response.status === 401) unauthorized?.()

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

  const data = dataSchema.parse(envelope.data)
  onAnswer?.('api')
  return data
}

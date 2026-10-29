import { z } from 'zod'

function createEnvelopeSchema<TSchema extends z.ZodTypeAny>(dataSchema: TSchema) {
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
  init?: RequestInit,
): Promise<z.infer<TSchema>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const json = await response.json()

  if (!response.ok) {
    const errorSchema = z.object({
      statusCode: z.number().int().optional(),
      message: z.string().optional(),
      description: z.string().nullable().optional(),
    })
    const parsedError = errorSchema.safeParse(json)

    if (parsedError.success) {
      throw parsedError.data
    }

    throw new Error('Request failed')
  }

  const envelope = createEnvelopeSchema(dataSchema).parse(json)

  return dataSchema.parse(envelope.data)
}

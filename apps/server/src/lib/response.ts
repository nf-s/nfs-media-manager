import { type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export const generateJsonResponse = <
  T,
  StatusCode extends ContentfulStatusCode,
>(
  c: Context,
  data: T,
  statusCode: StatusCode,
  message = 'OK',
) =>
  c.json(
    {
      statusCode: statusCode,
      message,
      data,
    },
    statusCode,
  )

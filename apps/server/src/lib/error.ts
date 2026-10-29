import type { ContentfulStatusCode } from 'hono/utils/http-status'

interface ServerErrorOptions {
  data?: unknown
  statusCode?: ContentfulStatusCode
  message?: string
  description?: string
}

export class ServerError extends Error {
  private statusCode: ContentfulStatusCode = 500
  public message = 'Something went wrong'
  private data: unknown
  private description: string | null = null

  constructor(options: ServerErrorOptions) {
    super(options.message)
    this.statusCode = options.statusCode || 500
    this.message = options.message || 'Something went wrong'
    this.data = options.data
    this.description = options.description || null
  }

  get response(): {
    statusCode: ContentfulStatusCode
    message: string
    data: unknown
    description: string | null
  } {
    return {
      statusCode: this.statusCode,
      message: this.message,
      data: this.data || null,
      description: this.description,
    }
  }
}

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeProviderResponseBody } from '@repo/media-plugin-sdk'
import { LOCAL_RESPONSE_BYTES } from '@repo/media-plugin-sdk/local-worker'
import { z } from 'zod'
import { redact, WorkerError, type WorkerConfig } from './config.js'
import {
  BodyTooLargeError,
  readBody,
  type HttpResponse,
  type Transport,
} from './http.js'

const safeMime = z.enum(['application/json', 'text/html', 'text/plain'])
const filteredSchema = z
  .object({ contentType: safeMime, text: z.string().min(1) })
  .strict()
const archiveSchema = filteredSchema
  .extend({
    version: z.literal(1),
    id: z.string().uuid(),
    capturedAt: z.number().int().nonnegative(),
    status: z.number().int().min(200).max(599),
    retainedBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

type Filter = (input: {
  contentType: string | null
  text: string
  sensitiveValues: string[]
}) => unknown

export const defaultResponseFilter: Filter = ({
  contentType,
  text,
  sensitiveValues,
}) => {
  const captured = sanitizeProviderResponseBody(
    { state: 'captured', text },
    contentType,
    sensitiveValues,
  )
  if (captured.state !== 'captured') return null
  return {
    contentType: /^[\s]*[\[{]/u.test(captured.text)
      ? 'application/json'
      : 'text/plain',
    text: captured.text,
  }
}

function filterFunction(value: unknown): value is Filter {
  return typeof value === 'function'
}

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

function owned(stat: Stats) {
  return process.getuid === undefined || stat.uid === process.getuid()
}

export async function loadResponseFilter(path: string | undefined) {
  if (path === undefined) return undefined
  try {
    if (!isAbsolute(path) || !path.endsWith('.mjs')) throw new Error()
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || stat.mode & 0o022)
      throw new Error()
    const module: unknown = await import(pathToFileURL(path).href)
    if (
      !module ||
      typeof module !== 'object' ||
      !('sanitizeResponse' in module) ||
      !filterFunction(module.sanitizeResponse)
    )
      throw new Error()
    return module.sanitizeResponse
  } catch {
    throw new WorkerError(
      'Response filter requires an absolute, owner-controlled .mjs module exporting sanitizeResponse',
    )
  }
}

function archiveDirectory(state: string, create = false) {
  const directory = join(state, 'capture')
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error
    }
  }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o777) !== 0o700)
    throw new WorkerError('Response capture archive is not private')
  return directory
}

function archiveResponse(
  directory: string,
  response: z.infer<typeof filteredSchema>,
  status: number,
) {
  const id = randomUUID()
  const retainedBytes = Buffer.byteLength(response.text)
  const record = {
    ...response,
    id,
    status,
    retainedBytes,
    version: 1,
    capturedAt: Date.now(),
    sha256: sha256(response.text),
  }
  const temporary = join(directory, '.' + id + '.tmp')
  try {
    const fd = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, JSON.stringify(record), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, join(directory, id + '.json'))
    const parent = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  return { reference: id, retainedBytes }
}

export function readFilteredCapture(state: string, reference: string) {
  const id = z.string().uuid().parse(reference)
  const directory = archiveDirectory(state)
  const fd = openSync(
    join(directory, id + '.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !owned(stat) ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > LOCAL_RESPONSE_BYTES * 2 + 4096
    )
      throw new WorkerError('Invalid response capture file')
    const record = archiveSchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
    if (
      record.id !== id ||
      record.retainedBytes !== Buffer.byteLength(record.text) ||
      record.sha256 !== sha256(record.text)
    )
      throw new WorkerError('Response capture integrity check failed')
    return record
  } finally {
    closeSync(fd)
  }
}

export function createFilteredTransport(
  config: WorkerConfig,
  filter: Filter,
  transport: Transport,
): Transport {
  const archive = archiveDirectory(config.stateDir, true)
  const secrets = [config.token, ...Object.values(config.credentials)]
  let archiveBlocked = false
  return async (url, options) => {
    if (
      options.method !== 'GET' ||
      new URL(url).origin !== config.policy.origin
    )
      return transport(url, options)
    if (archiveBlocked)
      throw new WorkerError('Cannot retain private provider response')
    const response = await transport(url, options)
    const headers = new Headers()
    for (const key of [
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'x-discogs-ratelimit',
      'x-discogs-ratelimit-used',
      'x-discogs-ratelimit-remaining',
    ]) {
      const value = response.headers.get(key)
      if (value) headers.set(key, redact(value, config))
    }
    const unavailable = (
      reason:
        | 'byte-limit'
        | 'read-failed'
        | 'redact-failed'
        | 'unsupported-format'
        | 'empty',
    ): HttpResponse => ({
      status: response.status,
      headers,
      capture: {
        contentType: null,
        body: { state: 'unavailable', reason },
      },
      body:
        response.status >= 200 &&
        response.status < 300 &&
        response.status !== 204 &&
        response.status !== 205
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(
                  reason === 'byte-limit'
                    ? new BodyTooLargeError()
                    : new WorkerError(
                        'Provider response could not be safely retained',
                      ),
                )
              },
            })
          : null,
    })
    let native
    try {
      native = await readBody(response, LOCAL_RESPONSE_BYTES, options.signal)
    } catch (error) {
      return unavailable(
        error instanceof BodyTooLargeError ? 'byte-limit' : 'read-failed',
      )
    }
    if (!native) return unavailable('empty')
    let clean
    try {
      const result = filter({
        contentType: response.headers.get('content-type'),
        text: native,
        sensitiveValues: secrets,
      })
      if (result === null) return unavailable('unsupported-format')
      clean = filteredSchema.parse(result)
      clean.text = redact(clean.text, config)
    } catch {
      return unavailable('redact-failed')
    }
    const retained = Buffer.byteLength(clean.text)
    if (retained > LOCAL_RESPONSE_BYTES) return unavailable('byte-limit')
    let stored
    try {
      stored = archiveResponse(archive, clean, response.status)
    } catch {
      archiveBlocked = true
      return unavailable('read-failed')
    }
    headers.set('content-type', clean.contentType)
    const capture: NonNullable<HttpResponse['capture']> = {
      contentType: clean.contentType,
      body: {
        state: 'captured',
        text: clean.text,
        redacted: clean.text !== native,
      },
    }
    return {
      status: response.status,
      headers,
      body: [204, 205, 304].includes(response.status)
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(clean.text))
              controller.close()
            },
          }),
      nativeBody: { redacted: clean.text !== native },
      capture:
        Buffer.byteLength(JSON.stringify(capture)) +
          Buffer.byteLength(JSON.stringify(clean.text)) <=
        LOCAL_RESPONSE_BYTES
          ? capture
          : {
              contentType: clean.contentType,
              body: { state: 'local', ...stored },
            },
    }
  }
}

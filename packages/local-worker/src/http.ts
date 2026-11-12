import { lookup } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { WorkerError, trustedOrigin } from './config.js'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] satisfies [string, number][])
  blocked.addSubnet(network, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] satisfies [string, number][])
  blocked.addSubnet(network, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  )
}

export interface HttpResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export interface HttpOptions {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
  canDispatch?: () => boolean
}

export type Transport = (
  url: string,
  options: HttpOptions,
) => Promise<HttpResponse>

export class DispatchExpiredError extends WorkerError {}

// Resolve and validate at socket connection time, not in a separate DNS preflight.
// Native HTTPS never follows redirects or uses an ambient cookie jar/proxy.
export const httpsTransport: Transport = (url, options) =>
  new Promise((resolve, reject) => {
    const destination = new URL(url)
    trustedOrigin(destination.origin)
    if (destination.username || destination.password || destination.hash)
      throw new WorkerError('Unsafe network destination refused')
    const canDispatch = () =>
      !options.signal.aborted && (options.canDispatch?.() ?? true)
    if (!canDispatch()) {
      reject(new DispatchExpiredError('Dispatch deadline elapsed'))
      return
    }
    const outgoing = request(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        agent: false,
        lookup(hostname, lookupOptions, callback) {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (!canDispatch())
              return callback(
                new DispatchExpiredError('Dispatch deadline elapsed'),
                '',
                4,
              )
            if (error) return callback(error, '', 4)
            const first = addresses[0]
            if (
              !first ||
              addresses.some(({ address }) => !isPublicAddress(address))
            ) {
              return callback(
                new WorkerError('Non-public network destination refused'),
                '',
                4,
              )
            }
            if (lookupOptions.all) callback(null, addresses)
            else callback(null, first.address, first.family)
          })
        },
      },
      (incoming) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') headers.set(name, value)
          else if (value) for (const item of value) headers.append(name, item)
        }
        incoming.pause()
        let closed = false
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on('data', (chunk: Buffer) => {
              if (closed) return
              controller.enqueue(chunk)
              incoming.pause()
            })
            incoming.once('end', () => {
              if (closed) return
              closed = true
              controller.close()
            })
            incoming.once('error', (error: Error) => {
              if (closed) return
              closed = true
              controller.error(error)
            })
          },
          pull() {
            if (!closed) incoming.resume()
          },
          cancel() {
            closed = true
            incoming.destroy()
          },
        })
        resolve({ status: incoming.statusCode ?? 0, headers, body })
      },
    )
    outgoing.once('error', reject)
    outgoing.once('socket', (socket) => {
      socket.prependOnceListener('secureConnect', () => {
        if (!canDispatch())
          outgoing.destroy(
            new DispatchExpiredError('Dispatch deadline elapsed'),
          )
        else outgoing.end(options.body)
      })
    })
  })

export class BodyTooLargeError extends Error {}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Request interrupted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function readBody(
  response: HttpResponse,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > limit) {
    void response.body?.cancel().catch(() => {})
    throw new BodyTooLargeError()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) throw new BodyTooLargeError()
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, length).toString('utf8')
  } finally {
    void reader.cancel().catch(() => {})
  }
}

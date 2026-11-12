import { EventEmitter } from 'node:events'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'

https.request = (url, options, respond) => {
  const outgoing = new EventEmitter()
  const socket = new EventEmitter()
  let keepAlive
  outgoing.destroy = (error) => {
    clearInterval(keepAlive)
    outgoing.emit('error', error)
    return outgoing
  }
  outgoing.end = () => {
    if (url.endsWith('/offline')) {
      if (options.signal.aborted)
        throw new Error('Offline must use an independent signal')
      process.stdout.write('mock-offline\n')
      setTimeout(
        () => {
          const incoming = new PassThrough()
          incoming.statusCode = 200
          incoming.headers = {}
          respond(incoming)
          incoming.end('{}')
          process.stdout.write('mock-offline-acknowledged\n')
        },
        Number(process.env.MOCK_OFFLINE_DELAY_MS ?? 0),
      )
      return
    }
    if (!url.endsWith('/poll')) throw new Error('Unexpected network operation')
    keepAlive = setInterval(() => {}, 1000)
    options.signal.addEventListener(
      'abort',
      () => outgoing.destroy(new Error('Aborted')),
      { once: true },
    )
    process.stdout.write('mock-poll-ready\n')
  }
  queueMicrotask(() => {
    outgoing.emit('socket', socket)
    socket.emit('secureConnect')
  })
  return outgoing
}
syncBuiltinESMExports()
globalThis.fetch = () => {
  throw new Error('Live fetch forbidden')
}

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  ArchivedAlbumReplayError,
  type ArchivedAlbumReplayInput,
} from './archived-album-replay'

export async function runIsolatedArchivedReplay(
  input: ArchivedAlbumReplayInput,
): Promise<unknown> {
  if (process.platform !== 'darwin')
    throw new ArchivedAlbumReplayError(
      'Archived commits require the macOS network and filesystem sandbox.',
    )
  const require = createRequire(import.meta.url)
  const worker = fileURLToPath(
    new URL('../../scripts/replay-archived-album-worker.ts', import.meta.url),
  )
  const exitFailure = () =>
    new ArchivedAlbumReplayError(
      'The network-isolated adapter could not reproduce the reviewed album.',
    )
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        '(version 1) (allow default) (deny network*) (deny file-write*)',
        process.execPath,
        '--import',
        require.resolve('tsx'),
        worker,
      ],
      {
        env: {
          TSX_DISABLE_CACHE: '1',
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL('../../tsconfig.json', import.meta.url),
          ),
        },
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 15_000,
        killSignal: 'SIGKILL',
      },
    )
    const output: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) child.kill('SIGKILL')
      else output.push(chunk)
    })
    child.on('error', () => reject(exitFailure()))
    child.stdin.on('error', () => reject(exitFailure()))
    child.on('close', (code) => {
      if (code !== 0 || bytes > 16 * 1024 * 1024) return reject(exitFailure())
      try {
        const result: unknown = JSON.parse(
          Buffer.concat(output).toString('utf8'),
        )
        resolve(result)
      } catch {
        reject(exitFailure())
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

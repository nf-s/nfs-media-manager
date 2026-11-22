import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// A copy of apps/server/scripts/preview/preview-ports.ts: the web Worker
// build stages apps/web alone. preview-ports.test.ts there keeps them equal.

/**
 * The preview's default ports for one checkout. Each checkout or worktree
 * gets its own pair, from 3710–3809 for the web app and 4710–4809 for the
 * API, so previews in two worktrees do not meet on the same ports.
 * `PREVIEW_WEB_PORT` and `PREVIEW_API_PORT` override them.
 */
export function defaultPreviewPorts(checkoutRoot: string): {
  web: number
  api: number
} {
  const offset =
    createHash('sha256')
      .update(resolve(checkoutRoot))
      .digest()
      .readUInt16BE(0) % 100
  return { web: 3710 + offset, api: 4710 + offset }
}

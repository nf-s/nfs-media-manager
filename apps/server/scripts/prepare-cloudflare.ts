import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from '../src/env'
import { findWorkspaceRootPath } from '../src/lib/load-workspace-env'

async function main() {
  const root = findWorkspaceRootPath(process.cwd())
  if (!root) throw new Error('Run this command from the configured workspace')
  const paths = env.MEDIA_PLUGIN_PATHS.map((path) => resolve(root, path))
  for (const path of paths) {
    if (!existsSync(path))
      throw new Error('A configured private plugin is missing')
  }
  const directory = resolve(root, '.cloudflare')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const imports = paths
    .map(
      (path, index) =>
        `import * as module${index} from ${JSON.stringify(path)}`,
    )
    .join('\n')
  const source = `${imports}
import { isMediaProviderPlugin, type MediaProviderPlugin } from '@repo/media-plugin-sdk'
function readPlugin(value: unknown): MediaProviderPlugin {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid bundled plugin module')
  const candidate = 'default' in value ? value.default : 'plugin' in value ? value.plugin : null
  if (!isMediaProviderPlugin(candidate)) throw new Error('Invalid bundled plugin')
  return candidate
}
export const bundledPlugins: MediaProviderPlugin[] = [${paths.map((_, index) => `readPlugin(module${index})`).join(',')}]
`
  await writeFile(resolve(directory, 'private-plugins.ts'), source, {
    mode: 0o600,
  })
  process.stdout.write(
    `Prepared ${paths.length} private provider packages for server-only deployment.\n`,
  )
}

void main().catch(() => {
  process.stderr.write(
    'Private provider build preparation failed. Verify configured plugin paths.\n',
  )
  process.exitCode = 1
})

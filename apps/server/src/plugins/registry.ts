import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import {
  isMediaProviderPlugin,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { env } from '@/env'
import { findWorkspaceRootPath } from '@/lib/load-workspace-env'
import {
  createCatalogEntryFromPlugin,
  getBuiltinProviderCatalog,
  type ProviderCatalogEntry,
} from '@/lib/provider-catalog'
import {
  getBuiltinScrapePlugin,
  listBuiltinScrapePlugins,
} from '@/plugins/builtin'

interface LoadedPlugin {
  plugin: MediaProviderPlugin
  pluginPath: string
}

let pluginCache: Map<string, LoadedPlugin> | null = null
const workspaceRoot = findWorkspaceRootPath(process.cwd()) ?? process.cwd()

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getPluginCandidate(moduleValue: unknown): unknown {
  if (!isObjectRecord(moduleValue)) {
    return moduleValue
  }

  if ('default' in moduleValue) {
    return moduleValue['default']
  }

  if ('plugin' in moduleValue) {
    return moduleValue['plugin']
  }

  return moduleValue
}

async function loadExternalPlugins(): Promise<Map<string, LoadedPlugin>> {
  if (pluginCache) {
    return pluginCache
  }

  const loaded = new Map<string, LoadedPlugin>()

  for (const pluginPath of env.MEDIA_PLUGIN_PATHS) {
    const resolvedPath = resolve(workspaceRoot, pluginPath)
    if (!existsSync(resolvedPath)) {
      console.warn(
        'Configured local media plugin is missing; continuing without it.',
      )
      continue
    }
    const moduleValue = await import(pathToFileURL(resolvedPath).href)
    const candidate = getPluginCandidate(moduleValue)

    if (!isMediaProviderPlugin(candidate)) {
      throw new Error(`Invalid media plugin exported from ${resolvedPath}`)
    }

    if (
      loaded.has(candidate.manifest.id) ||
      getBuiltinProviderCatalog().some(
        (provider) => provider.id === candidate.manifest.id,
      )
    ) {
      throw new Error('Local plugin conflicts with an existing provider ID')
    }
    loaded.set(candidate.manifest.id, {
      plugin: candidate,
      pluginPath: resolvedPath,
    })
  }

  pluginCache = loaded
  return loaded
}

export async function listProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  const builtins = getBuiltinProviderCatalog()
  const plugins = await loadExternalPlugins()
  const pluginCatalogEntries = Array.from(plugins.values()).map(
    ({ plugin, pluginPath }) =>
      createCatalogEntryFromPlugin(plugin, pluginPath),
  )

  const merged = new Map<string, ProviderCatalogEntry>()

  for (const provider of builtins) {
    merged.set(provider.id, provider)
  }

  for (const provider of pluginCatalogEntries) {
    merged.set(provider.id, provider)
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )
}

export async function getScrapePlugin(
  providerId: string,
): Promise<MediaProviderPlugin | null> {
  const builtinPlugin = getBuiltinScrapePlugin(providerId)

  if (builtinPlugin) {
    return builtinPlugin
  }

  const plugins = await loadExternalPlugins()
  return plugins.get(providerId)?.plugin ?? null
}

export async function listLoadedScrapePlugins(): Promise<
  MediaProviderPlugin[]
> {
  const plugins = await loadExternalPlugins()
  return [
    ...listBuiltinScrapePlugins(),
    ...Array.from(plugins.values()).map((entry) => entry.plugin),
  ]
}

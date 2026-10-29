import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from '@repo/schemas/common'
import {
  isSpotifyAudioFeatureKey,
  removeSpotifyAudioFeatures,
} from '@repo/schemas/audio-features'
import { checksumJson } from './media-utils'

export const AudioCleanupRowSchema = z.record(z.string(), JsonValueSchema)
export type AudioCleanupRow = z.infer<typeof AudioCleanupRowSchema>
export interface AudioCleanupTarget {
  table: string
  idColumn: string
  columns: string[]
  scope: string
}

const albumScope = (column: string) =>
  `exists (select 1 from media_item m where m.id = t.${column} and m.media_type = 'album')`

// Identifiers and predicates are fixed code, never CLI input.
export const audioCleanupTargets: AudioCleanupTarget[] = [
  {
    table: 'media_item',
    idColumn: 'id',
    columns: ['metadata'],
    scope: "t.media_type = 'album'",
  },
  {
    table: 'album',
    idColumn: 'media_item_id',
    columns: ['metadata'],
    scope: albumScope('media_item_id'),
  },
  {
    table: 'track',
    idColumn: 'id',
    columns: ['metadata'],
    scope: albumScope('album_media_item_id'),
  },
  {
    table: 'provider_reference',
    idColumn: 'id',
    columns: ['metadata'],
    scope: albumScope('media_item_id'),
  },
  {
    table: 'media_override',
    idColumn: 'id',
    columns: ['value'],
    scope: albumScope('media_item_id'),
  },
  {
    table: 'provider_snapshot',
    idColumn: 'id',
    columns: ['payload', 'normalized_data'],
    scope: `(${albumScope('media_item_id')} or t.provider in ('spotify', 'spotify-audio-features', 'legacy-smart-playlists') or (t.provider = 'legacy-library' and t.source = 'legacy-import:lib-music.json') or (t.media_item_id is null and t.source like 'legacy%' and t.payload ? 'spotify'))`,
  },
  {
    table: 'provider_current_state',
    idColumn: 'id',
    columns: ['payload', 'normalized_data'],
    scope: albumScope('media_item_id'),
  },
  {
    table: 'scrape_job_item',
    idColumn: 'id',
    columns: ['payload'],
    scope: albumScope('media_item_id'),
  },
]

export function planAudioFeatureCleanup(
  target: AudioCleanupTarget,
  input: unknown,
) {
  const row = AudioCleanupRowSchema.parse(input)
  const updates: Record<string, JsonValue> = {}
  const removed: Record<string, number> = {}
  for (const column of target.columns) {
    const value = row[column]
    if (value === undefined || value === null) continue
    const overrideField =
      target.table === 'media_override' && typeof row.field === 'string'
        ? row.field.replace(/^(?:metadata\.)?(?:browse\.)?/, '')
        : undefined
    if (overrideField && isSpotifyAudioFeatureKey(overrideField)) {
      updates[column] = null
      removed[`override:${overrideField}`] = 1
      continue
    }
    const result = removeSpotifyAudioFeatures(
      value,
      target.table !== 'media_override',
    )
    if (!result.changed) continue
    updates[column] = result.value
    for (const [key, count] of Object.entries(result.removed)) {
      removed[key] = (removed[key] ?? 0) + count
    }
  }
  if (
    Object.keys(updates).length &&
    (target.table === 'provider_snapshot' ||
      target.table === 'provider_current_state')
  ) {
    const payload = updates.payload ?? row.payload
    const normalized = updates.normalized_data ?? row.normalized_data
    updates.checksum =
      row.provider === 'legacy-library' ||
      row.provider === 'legacy-smart-playlists'
        ? checksumJson(payload)
        : checksumJson({ provider: row.provider, payload, normalized })
  }
  return { updates, removed, changed: Object.keys(updates).length > 0 }
}

export interface AudioCleanupStore {
  read: (
    target: AudioCleanupTarget,
    cursor: string | undefined,
  ) => Promise<AudioCleanupRow[]>
  backup: (
    target: AudioCleanupTarget,
    row: AudioCleanupRow,
    updates: Record<string, JsonValue>,
  ) => Promise<void>
  update: (
    target: AudioCleanupTarget,
    id: string,
    updates: Record<string, JsonValue>,
    before: AudioCleanupRow,
  ) => Promise<void>
}

export async function runAudioFeatureCleanup(
  store: AudioCleanupStore,
  apply = false,
) {
  const tables: Record<
    string,
    {
      scanned: number
      changed: number
      updated: number
      columns: Record<string, number>
      removed: Record<string, number>
    }
  > = {}
  for (const target of audioCleanupTargets) {
    const counts = {
      scanned: 0,
      changed: 0,
      updated: 0,
      columns: {},
      removed: {},
    }
    const report: (typeof tables)[string] = counts
    tables[target.table] = report
    let cursor: string | undefined
    for (;;) {
      const rows = await store.read(target, cursor)
      if (!rows.length) break
      for (const row of rows) {
        const id = z.string().min(1).parse(row[target.idColumn])
        report.scanned++
        const plan = planAudioFeatureCleanup(target, row)
        if (plan.changed) {
          report.changed++
          for (const key of Object.keys(plan.updates))
            report.columns[key] = (report.columns[key] ?? 0) + 1
          for (const [key, count] of Object.entries(plan.removed))
            report.removed[key] = (report.removed[key] ?? 0) + count
          if (apply) {
            await store.backup(target, row, plan.updates)
            await store.update(target, id, plan.updates, row)
            report.updated++
          }
        }
        cursor = id
      }
    }
  }
  return {
    apply,
    tables,
    changedRows: Object.values(tables).reduce(
      (sum, table) => sum + table.changed,
      0,
    ),
  }
}

export function parseAudioCleanupArguments(args: string[]) {
  let apply = false
  let dryRun = false
  let backupDirectory: string | undefined
  for (const arg of args) {
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--backup-dir=') && arg.slice(13).trim())
      backupDirectory = arg.slice(13)
    else throw new Error(`Unknown cleanup argument: ${arg}`)
  }
  if (apply && dryRun) throw new Error('Choose --dry-run or --apply, not both')
  if (apply && !backupDirectory)
    throw new Error('--apply requires --backup-dir=<new-private-directory>')
  if (!apply && backupDirectory)
    throw new Error('--backup-dir is only used with --apply')
  return { apply, backupDirectory }
}

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { BrowseValuesSchema, getBrowseValues } from '@repo/schemas/browse'
import { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import {
  LegacyBrowseRecordSchema,
  normalizeLegacyBrowse,
} from '@/lib/legacy-browse'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { getAlbumDetail, getFilmDetail } from '@/services/media'

// Read-only reconciliation. Local plugin hooks normalize fixtures; never scrape.
async function main() {
  const plugins = await listLoadedScrapePlugins()
  const failures: Array<{
    id: string
    field: string
    expected: unknown
    actual: unknown
  }> = []
  const counts = { albums: 0, films: 0, fields: 0, links: 0, duplicateRows: 0 }
  const recordSchema = z.record(z.string(), LegacyBrowseRecordSchema)
  function compare(
    id: string,
    field: string,
    expected: unknown,
    actual: unknown,
  ) {
    counts.fields++
    const normalize = (value: unknown) =>
      Array.isArray(value)
        ? [...new Set(value.map((item) => String(item).toLowerCase()))].sort()
        : value
    if (
      JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))
    )
      failures.push({ id, field, expected, actual })
  }
  for (const mediaType of ['album', 'film']) {
    if (mediaType !== 'album' && mediaType !== 'film') continue
    const path = fileURLToPath(
      new URL(
        `../../web/public/data/${mediaType === 'album' ? 'lib-music.json' : 'lib-movie.json'}`,
        import.meta.url,
      ),
    )
    const input: unknown = JSON.parse(await readFile(path, 'utf8'))
    const music =
      mediaType === 'album'
        ? z
            .object({
              albums: recordSchema,
              playlists: z.record(z.string(), z.object({ name: z.string() })),
            })
            .parse(input)
        : null
    const rows = music
      ? Object.values(music.albums)
      : z.array(LegacyBrowseRecordSchema).parse(input)
    const playlistNames = Object.fromEntries(
      Object.entries(music?.playlists ?? {}).map(([id, value]) => [
        id,
        value.name,
      ]),
    )
    const seen = new Set<string>()
    for (const row of rows) {
      const externalId =
        mediaType === 'album'
          ? z.object({ spotify: z.string() }).parse(row.id).spotify
          : z.string().parse(row.id)
      const id = createStableId(
        mediaType,
        `${mediaType}:${mediaType === 'album' ? `spotify:${externalId}` : externalId}`,
      )
      if (seen.has(id)) {
        counts.duplicateRows++
        continue
      }
      seen.add(id)
      const detail =
        mediaType === 'album'
          ? await getAlbumDetail(id)
          : await getFilmDetail(id)
      if (!detail) {
        failures.push({ id, field: 'record', expected: true, actual: false })
        continue
      }
      if (mediaType === 'album') counts.albums++
      else counts.films++
      const normalized = normalizeLegacyBrowse(
        row,
        mediaType,
        playlistNames,
      ).normalized
      const actual = getBrowseValues(detail)
      const expected = BrowseValuesSchema.parse(
        normalized.mediaPatch?.metadata?.browse,
      )
      // Collections can be enriched by plugins; playlist IDs become readable names.
      delete expected.provider
      delete expected.updatedAt
      delete expected.source
      delete expected.collection
      if (Array.isArray(expected.playlist))
        expected.playlist = expected.playlist.map(
          (value) => playlistNames[value] ?? value,
        )
      if (typeof expected.durationSec === 'number')
        expected.durationSec = Math.round(expected.durationSec)
      for (const [field, value] of Object.entries(expected)) {
        if (value !== null) compare(id, field, value, actual[field])
      }
      compare(id, 'title', row.title, detail.title)
      compare(
        id,
        'artworkUrl',
        normalized.mediaPatch?.artworkUrl ?? null,
        detail.artworkUrl,
      )
      let expectedSource = normalized.filmPatch?.sourceKind
      for (const link of normalized.links) {
        counts.links++
        if (
          !detail.links.some(
            (actual) =>
              actual.url.replace(/\/$/, '') === link.url.replace(/\/$/, ''),
          )
        )
          failures.push({ id, field: 'link', expected: link.url, actual: null })
      }
      for (const plugin of plugins) {
        if (!plugin.importLegacyRecord) continue
        const result = await plugin.importLegacyRecord({
          rawRecord: row,
          mediaType,
        })
        if (!result) continue
        const patch = PluginResultSchema.parse(result).normalized
        expectedSource = patch.filmPatch?.sourceKind ?? expectedSource
        const values = BrowseValuesSchema.parse(
          patch.mediaPatch?.metadata?.browse ?? {},
        )
        for (const [field, value] of Object.entries(values))
          if (value !== null) compare(id, field, value, actual[field])
        for (const reference of patch.references) {
          if (
            !detail.providerReferences.some(
              (r) =>
                r.provider === plugin.manifest.id &&
                r.externalId === reference.externalId,
            )
          )
            failures.push({
              id,
              field: 'pluginReference',
              expected: reference.externalId,
              actual: null,
            })
        }
      }
      if (expectedSource)
        compare(
          id,
          'sourceKind',
          expectedSource,
          detail.mediaType === 'film' ? detail.sourceKind : null,
        )
    }
  }
  process.stdout.write(
    JSON.stringify(
      { counts, mismatchCount: failures.length, failures },
      null,
      2,
    ) + '\n',
  )
  if (failures.length) process.exitCode = 1
}

void main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$client.end())

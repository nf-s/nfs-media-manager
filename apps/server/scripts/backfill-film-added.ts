import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import {
  PluginResultSchema,
  PluginNormalizedResultSchema,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import {
  earliestFilmAddedDate,
  filmAddedDate,
  legacyFilmAddedDate,
  type FilmAddedDate,
} from '@/lib/film-added-date'
import { normalizeImdbCsv } from '@/lib/film-file-normalizers'
import { isJsonRecord } from '@/lib/provider-normalizers'
import { z } from 'zod'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { film, mediaItem, providerSnapshot } from '@/schemas/db'
import { recordFilmAddedDate } from '@/services/film-added-dates'

// Offline repair from retained imports only. Never invokes a scraper or reads credentials.
export async function backfillFilmAddedDates(apply = false) {
  const plugins = (await listLoadedScrapePlugins()).filter(
    (plugin) => plugin.importLegacyRecord,
  )
  const providers = [
    'legacy-record',
    'legacy-browser',
    'nfo',
    'imdb-personal',
    'imdb-ratings',
    'imdb-watchlist',
    ...plugins.map((plugin) => plugin.manifest.id),
  ]
  const dates = new Map<string, FilmAddedDate>()
  let cursor: string | undefined
  let scanned = 0
  for (;;) {
    const rows = await db
      .select({
        id: providerSnapshot.id,
        mediaItemId: providerSnapshot.mediaItemId,
        provider: providerSnapshot.provider,
        source: providerSnapshot.source,
        payload: providerSnapshot.payload,
        normalized: providerSnapshot.normalizedData,
      })
      .from(providerSnapshot)
      .innerJoin(mediaItem, eq(mediaItem.id, providerSnapshot.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, 'film'),
          inArray(providerSnapshot.provider, providers),
          sql`(${providerSnapshot.source} like 'legacy%' or ${providerSnapshot.source} = 'file-import')`,
          cursor ? gt(providerSnapshot.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(providerSnapshot.id))
      .limit(100)
    if (!rows.length) break
    for (const row of rows) {
      scanned++
      if (!row.mediaItemId) continue
      const payload =
        row.source === 'file-import' &&
        isJsonRecord(row.payload) &&
        row.payload.data !== undefined
          ? row.payload.data
          : row.payload
      const normalized = PluginNormalizedResultSchema.parse(
        row.normalized ?? undefined,
      )
      const candidates = [
        dates.get(row.mediaItemId),
        legacyFilmAddedDate(payload),
        filmAddedDate(
          normalized.filmPatch?.dateAdded,
          normalized.filmPatch?.dateAddedSource ??
            'Imported source date (estimated)',
        ),
      ]
      if (
        row.provider === 'imdb-ratings' ||
        row.provider === 'imdb-watchlist'
      ) {
        const csv = z.record(z.string(), z.string()).safeParse(payload)
        if (csv.success) {
          const patch = normalizeImdbCsv(csv.data, row.provider)?.normalized
            .filmPatch
          candidates.push(
            filmAddedDate(
              patch?.dateAdded,
              patch?.dateAddedSource ?? 'IMDb list (estimated)',
            ),
          )
        }
      }
      for (const plugin of plugins) {
        if (
          !plugin.importLegacyRecord ||
          (row.provider !== 'legacy-record' &&
            row.provider !== plugin.manifest.id)
        )
          continue
        const result = await plugin.importLegacyRecord({
          rawRecord: payload,
          mediaType: 'film',
        })
        if (result) {
          const patch = PluginResultSchema.parse(result).normalized.filmPatch
          candidates.push(
            filmAddedDate(
              patch?.dateAdded,
              patch?.dateAddedSource ??
                `${plugin.manifest.displayName} import (estimated)`,
            ),
          )
        }
      }
      const earliest = earliestFilmAddedDate(candidates)
      if (earliest) dates.set(row.mediaItemId, earliest)
    }
    cursor = rows.at(-1)?.id
  }
  let updated = 0
  if (apply)
    await db.transaction(async (tx) => {
      for (const [id, date] of dates)
        updated += (await recordFilmAddedDate(tx, id, date)).length
    })
  const counts = await db
    .select({
      source: sql<string>`coalesce(${film.dateAddedSource}, 'Library import (original date unknown)')`,
      count: sql<number>`count(*)::int`,
    })
    .from(film)
    .innerJoin(mediaItem, eq(mediaItem.id, film.mediaItemId))
    .where(sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`)
    .groupBy(film.dateAddedSource)
  return {
    apply,
    scanned,
    recoverable: dates.size,
    updated,
    visibleFilms: counts,
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void backfillFilmAddedDates(process.argv.includes('--apply'))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => db.$client.end())
}

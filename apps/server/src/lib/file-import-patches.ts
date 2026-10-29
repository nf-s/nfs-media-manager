import type { PluginNormalizedResult } from '@repo/media-plugin-sdk'
import type { film, mediaItem } from '@/schemas/db'

// Keep preview and persistence on the same gap-filling/personal-state policy.
export function resolveFileImportPatches(
  normalized: PluginNormalizedResult,
  existing: typeof mediaItem.$inferSelect | undefined,
  existingFilm: typeof film.$inferSelect | undefined,
) {
  const { mediaPatch, filmPatch } = normalized
  const keepSource =
    existingFilm?.sourceKind === 'file' ||
    existingFilm?.sourceKind === 'bluray' ||
    (existingFilm?.watched && filmPatch?.sourceKind !== 'file') ||
    (!!existing?.sourceLabel &&
      filmPatch?.sourceKind !== 'file' &&
      filmPatch?.sourceKind !== 'imdb-ratings' &&
      filmPatch?.sourceKind !== 'imdb-watchlist')
  return {
    mediaPatch: mediaPatch
      ? {
          ...mediaPatch,
          title: existing?.title ? undefined : mediaPatch.title,
          originalTitle: existing?.originalTitle
            ? undefined
            : mediaPatch.originalTitle,
          summary: existing?.summary ? undefined : mediaPatch.summary,
          artworkUrl: existing?.artworkUrl ? undefined : mediaPatch.artworkUrl,
          releaseDate: existing?.releaseDate
            ? undefined
            : mediaPatch.releaseDate,
          sourceLabel: keepSource ? undefined : mediaPatch.sourceLabel,
          metadata: { ...mediaPatch.metadata, legacyHidden: false },
        }
      : undefined,
    filmPatch: filmPatch
      ? {
          ...filmPatch,
          watched: existingFilm?.watched ? undefined : filmPatch.watched,
          sourceKind: keepSource ? undefined : filmPatch.sourceKind,
          runtimeMinutes: existingFilm?.runtimeMinutes
            ? undefined
            : filmPatch.runtimeMinutes,
        }
      : undefined,
  }
}

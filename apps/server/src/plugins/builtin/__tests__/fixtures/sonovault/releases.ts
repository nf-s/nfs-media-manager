/** Invented Sonovault releases shaped like `GET /v1/releases/{id}`. */

import { sonovaultTrackFixture } from '.'

type Source = 'spotify' | 'discogs' | 'musicbrainz' | 'beatport' | 'applemusic'

export type SonovaultFixtureEdition = {
  id: number
  source: Source
  externalId: string
  groupId?: string | null
  barcode?: string | null
  tracksOnRow?: number
  catalogNo?: string | null
}

export function sonovaultEditionFixture(edition: SonovaultFixtureEdition) {
  return {
    id: edition.id,
    source: edition.source,
    external_id: edition.externalId,
    group_external_id: edition.groupId ?? null,
    title: null,
    edition_kind: 'album' as const,
    format: 'digital' as const,
    official: true,
    release_date: '2020-01-01',
    date_precision: 'day' as const,
    barcode: edition.barcode ?? null,
    country: null,
    medium_count: 1,
    track_count: edition.tracksOnRow ?? 4,
    tracks_on_row: edition.tracksOnRow ?? 4,
    label: { id: 9100 + edition.id, name: `Fixture Label ${edition.id}` },
    catalog_no: edition.catalogNo ?? null,
  }
}

export type SonovaultFixtureReleaseTrack = {
  id: number
  title: string
  duration: number | null
  isrc?: string | null
  disc?: number | null
  number?: number | null
}

export function sonovaultReleaseFixture(release: {
  id: number
  title?: string
  tracks: SonovaultFixtureReleaseTrack[]
  editions: SonovaultFixtureEdition[]
  edition?: number | null
  digitalUpc?: string | null
  releaseGroups?: string[]
}) {
  return {
    id: release.id,
    title: release.title ?? `Fixture Release ${release.id}`,
    artist: { id: 7001, name: 'Fixture Artist' },
    label: { id: 9001, name: 'Fixture Label' },
    release_date: '2020-01-01',
    catalog_no: 'FIX-001',
    musicbrainz_release_ids: [],
    musicbrainz_release_group_ids: release.releaseGroups ?? [],
    tracks: release.tracks.map((entry) => {
      const fields: Partial<ReturnType<typeof sonovaultTrackFixture>> =
        sonovaultTrackFixture(entry.id, {
          title: entry.title,
          duration: entry.duration,
          isrc: entry.isrc,
        })
      delete fields.releases
      return {
        ...fields,
        disc_number: entry.disc === undefined ? 1 : entry.disc,
        track_number: entry.number ?? null,
      }
    }),
    editions: release.editions.map(sonovaultEditionFixture),
    edition: release.edition ?? null,
    digital_upc: release.digitalUpc ?? null,
  }
}

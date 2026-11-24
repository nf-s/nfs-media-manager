import { parseOptionalDate } from '@/lib/media-utils'
import {
  sonovaultLinkUrl,
  type SonovaultLink,
  type SonovaultRelease,
  type SonovaultReleaseTrack,
  type SonovaultTrack,
} from '@/lib/sonovault-api'
import { db } from '@/lib/db'
import { observeCatalogMedia, type CatalogOrigin } from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function observeSonovaultTrack(
  tx: Transaction,
  track: SonovaultTrack | SonovaultReleaseTrack,
  links: SonovaultLink[],
  origin: Omit<CatalogOrigin, 'provider'>,
) {
  const provider = 'sonovault'
  const id = await observeCatalogMedia(
    tx,
    {
      kind: 'track',
      title: track.title,
      provider,
      referenceType: 'sonovault-track',
      externalId: String(track.id),
      durationSec: track.duration,
      credits: track.artists.map((artist) => ({
        name: artist.name,
        externalId: String(artist.id),
        role: artist.is_remixer && !artist.is_primary ? 'remixer' : 'artist',
      })),
      referenceMetadata: {
        isrc: track.isrc,
        links: links.map((link) => ({
          provider: link.source,
          id: link.external_id,
          url: sonovaultLinkUrl(link),
        })),
      },
    },
    { ...origin, provider },
  )
  if ('releases' in track)
    for (const [index, release] of track.releases.entries()) {
      await observeCatalogMedia(
        tx,
        {
          kind: 'album',
          title: release.title,
          provider,
          referenceType: 'sonovault-release',
          externalId: String(release.id),
          releaseDate: parseOptionalDate(release.release_date),
          credits: [
            {
              name: release.artist.name,
              externalId: String(release.artist.id),
            },
          ],
        },
        {
          ...origin,
          provider,
          relationshipRole: 'release',
          occurrenceKey: JSON.stringify([
            origin.occurrenceKey,
            'release',
            index + 1,
          ]),
          subjectKind: 'track',
          subjectId: id,
          position: index + 1,
        },
      )
    }
  return id
}

export async function observeSonovaultRelease(
  tx: Transaction,
  release: SonovaultRelease,
  origin: Omit<CatalogOrigin, 'provider'>,
) {
  const provider = 'sonovault'
  const credits = [
    { name: release.artist.name, externalId: String(release.artist.id) },
  ]
  const releaseId = await observeCatalogMedia(
    tx,
    {
      kind: 'album',
      title: release.title,
      provider,
      referenceType: 'sonovault-release',
      externalId: String(release.id),
      releaseDate: parseOptionalDate(release.release_date),
      credits,
    },
    { ...origin, provider },
  )
  const editions = new Map<number, string>()
  for (const [index, edition] of release.editions.entries()) {
    const id = await observeCatalogMedia(
      tx,
      {
        kind: 'album',
        title: edition.title ?? release.title,
        provider,
        referenceType: 'sonovault-edition',
        externalId: String(edition.id),
        releaseDate: parseOptionalDate(edition.release_date),
        credits,
        trackCount: edition.track_count ?? undefined,
        referenceMetadata: {
          provider: edition.source,
          externalId: edition.external_id,
          releaseGroupId: edition.group_external_id,
          format: edition.format,
          barcode: edition.barcode,
          label: edition.label?.name ?? null,
          catalogNumber: edition.catalog_no,
        },
      },
      {
        ...origin,
        provider,
        subjectKind: 'album',
        subjectId: releaseId,
        relationshipRole: 'edition',
        position: index + 1,
        occurrenceKey: JSON.stringify([
          origin.occurrenceKey,
          'edition',
          index + 1,
        ]),
      },
    )
    editions.set(edition.id, id)
  }
  for (const [index, track] of release.tracks.entries())
    await observeSonovaultTrack(tx, track, [], {
      ...origin,
      subjectKind: 'album',
      subjectId:
        (release.edition === null
          ? undefined
          : editions.get(release.edition)) ?? releaseId,
      relationshipRole: 'track_on_edition',
      position: index + 1,
      occurrenceKey: JSON.stringify([
        origin.occurrenceKey,
        release.edition,
        'track',
        index + 1,
      ]),
      details: { disc: track.disc_number, trackNumber: track.track_number },
    })
}

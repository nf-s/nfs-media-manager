import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { PluginNormalizedResultSchema } from '@repo/media-plugin-sdk'
import {
  AlbumMetacriticCandidateSchema,
  AlbumMetacriticCandidatesInputSchema,
  AlbumMetacriticCandidatesSchema,
  AlbumMetacriticCorrectionInputSchema,
  AlbumMetacriticCorrectionSchema,
  type AlbumMatchRejectionInput,
  type AlbumMetacriticCandidatesInput,
  type AlbumMetacriticCorrectionInput,
} from '@repo/schemas/match-diagnostics'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { redactJobText } from '@/lib/job-errors'
import { checksumJson } from '@/lib/media-utils'
import {
  readSerplyPageResults,
  searchSerplyPage,
} from '@/plugins/builtin/serply'
import {
  mediaItem,
  mediaOverride,
  providerCurrentState,
  providerSnapshot,
} from '@/schemas/db'
import {
  hasCurrentAlbumMatch,
  isSameAlbumMatch,
  lockAlbumMatch,
  readAlbumMatchRejections,
} from './album-match-rejections'
import { providerOperation } from './manual-add'
import { applyProviderResultInTransaction } from './provider-state'

export const albumMetacriticCorrectionField = 'albumMetacriticCorrection'
const provider = 'metacritic'

function conflict(message: string) {
  return new ServerError({ statusCode: 409, message })
}

type MatchDatabase = Parameters<typeof readAlbumMatchRejections>[0]

function currentMetacriticMatch(mediaItemId: string) {
  return and(
    eq(providerCurrentState.mediaItemId, mediaItemId),
    eq(providerCurrentState.provider, provider),
  )
}

async function requireArchivedRejection(
  database: MatchDatabase,
  mediaItemId: string,
  rejected: AlbumMetacriticCorrectionInput['rejected'],
  rejections: AlbumMatchRejectionInput[],
) {
  if (
    !rejections.some((previous) => isSameAlbumMatch(previous, rejected)) ||
    !(await hasCurrentAlbumMatch(database, mediaItemId, rejected))
  )
    throw conflict(
      'The rejected Metacritic match changed. Refresh Matches and try again.',
    )
  const archived = await database.query.providerSnapshot.findFirst({
    columns: { id: true },
    where: and(
      eq(providerSnapshot.id, rejected.snapshotId),
      eq(providerSnapshot.mediaItemId, mediaItemId),
      eq(providerSnapshot.provider, rejected.sourceProvider),
    ),
  })
  if (!archived)
    throw conflict('The rejected Metacritic source is unavailable.')
}

async function unresolvedMetacriticRejections(
  database: MatchDatabase,
  mediaItemId: string,
  rejected: AlbumMetacriticCandidatesInput['rejected'],
) {
  await lockAlbumMatch(database, mediaItemId)
  const current = await database.query.providerCurrentState.findFirst({
    columns: { id: true },
    where: currentMetacriticMatch(mediaItemId),
  })
  if (current)
    throw conflict('A Metacritic correction already exists for this album.')
  const rejections = await readAlbumMatchRejections(database, mediaItemId)
  await requireArchivedRejection(database, mediaItemId, rejected, rejections)
  return rejections
}

function searchPhrase(value: string) {
  return value
    .replace(/["\\\s]+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** Read one indexed page while the specified archived rejection is still unresolved. */
export async function searchAlbumMetacriticCandidates(
  mediaItemId: string,
  input: AlbumMetacriticCandidatesInput,
) {
  const { rejected } = AlbumMetacriticCandidatesInputSchema.parse(input)
  const query = await db.transaction(async (tx) => {
    await unresolvedMetacriticRejections(tx, mediaItemId, rejected)
    const record = await tx.query.mediaItem.findFirst({
      columns: { title: true },
      where: eq(mediaItem.id, mediaItemId),
      with: {
        credits: {
          columns: {},
          where: (table, operators) => operators.eq(table.role, 'artist'),
          orderBy: (table, operators) => [
            operators.asc(table.billingOrder),
            operators.asc(table.artistId),
          ],
          with: { artist: { columns: { name: true } } },
        },
      },
    })
    const title = searchPhrase(record?.title ?? '')
    const artist = record?.credits
      .map((credit) => searchPhrase(credit.artist.name))
      .find(Boolean)
    if (!title || !artist)
      throw new ServerError({
        statusCode: 422,
        message: 'Metacritic search requires an album title and artist.',
      })
    return 'site:metacritic.com/music/ "' + title + '" "' + artist + '"'
  })

  // Release the album lock before the provider request can wait for capacity.
  const results = await providerOperation(
    'serply',
    async (context) => {
      const credentials = Object.values(context.secrets).flatMap((value) => [
        value,
        value.trim(),
      ])
      const page = await searchSerplyPage(context, query)
      return readSerplyPageResults(page).flatMap(
        ({ link, title, description, indexedDate }) => {
          if (redactJobText(link, credentials) !== link) return []
          const parsed = AlbumMetacriticCandidateSchema.safeParse({
            url: link,
            title: redactJobText(title, credentials),
            description: redactJobText(description, credentials),
            indexedDate,
          })
          return parsed.success ? [parsed.data] : []
        },
      )
    },
    undefined,
    'searching for Metacritic candidates',
  )
  const rejections = await db.transaction((tx) =>
    unresolvedMetacriticRejections(tx, mediaItemId, rejected),
  )
  const isRejected = createAlbumMatchRejectionPredicate(provider, rejections)
  return AlbumMetacriticCandidatesSchema.parse({
    items: results.filter(
      ({ url }) =>
        !isRejected({ referenceType: 'metacritic-url', externalId: url }),
    ),
  })
}

/** Records an authorized identity correction and preserves its source observations. */
export async function correctAlbumMetacriticMatch(
  mediaItemId: string,
  input: AlbumMetacriticCorrectionInput,
  userId: string | null,
) {
  const correction = AlbumMetacriticCorrectionInputSchema.parse(input)
  const { rejected, replacement } = correction
  const reference = {
    referenceType: 'metacritic-url',
    externalId: replacement.url,
  }
  const whereCurrent = currentMetacriticMatch(mediaItemId)
  return db.transaction(async (tx) => {
    await lockAlbumMatch(tx, mediaItemId)
    const rejections = await readAlbumMatchRejections(tx, mediaItemId)
    const isRejected = createAlbumMatchRejectionPredicate(provider, rejections)
    if (isRejected(reference))
      throw conflict('This Metacritic release was previously rejected.')

    const current = await tx.query.providerCurrentState.findFirst({
      where: whereCurrent,
    })
    if (current) {
      const saved = AlbumMetacriticCorrectionInputSchema.safeParse(
        current.payload,
      )
      if (
        saved.success &&
        current.latestSnapshotId &&
        checksumJson(saved.data) === checksumJson(correction)
      )
        return AlbumMetacriticCorrectionSchema.parse({
          snapshotId: current.latestSnapshotId,
          url: replacement.url,
        })
      throw conflict('A Metacritic correction already exists for this album.')
    }

    await requireArchivedRejection(tx, mediaItemId, rejected, rejections)

    await applyProviderResultInTransaction(
      {
        mediaItemId,
        mediaType: 'album',
        provider,
        source: 'album-match-correction',
        payload: correction,
        normalized: PluginNormalizedResultSchema.parse({
          mediaPatch: {
            metadata: {
              browse: {
                ratingMetacriticValue: null,
                ratingMetacriticVotes: null,
              },
            },
          },
          references: [{ ...reference, isPrimary: true }],
          links: [{ provider, label: 'Metacritic', url: replacement.url }],
        }),
      },
      tx,
    )
    const corrected = await tx.query.providerCurrentState.findFirst({
      columns: { latestSnapshotId: true },
      where: whereCurrent,
    })
    if (!corrected?.latestSnapshotId)
      throw new Error('Could not save the Metacritic correction.')
    await tx.insert(mediaOverride).values({
      id: nanoid(),
      mediaItemId,
      field: albumMetacriticCorrectionField,
      value: { snapshotId: corrected.latestSnapshotId, url: replacement.url },
      createdByUserId: userId,
    })
    return AlbumMetacriticCorrectionSchema.parse({
      snapshotId: corrected.latestSnapshotId,
      url: replacement.url,
    })
  })
}

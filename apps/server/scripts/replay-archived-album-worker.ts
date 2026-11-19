import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  isMediaProviderPlugin,
  isProviderItemAmbiguousError,
  isProviderItemNotFoundError,
  JsonValueSchema,
  PluginArtistResultSchema,
  PluginResultSchema,
} from '@repo/media-plugin-sdk'
import {
  archiveSha256,
  ArchivedAlbumReplayInputSchema,
  type ArchivedAlbumReplayInput,
} from '@/lib/archived-album-replay'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { createProviderResponseReplay } from '@/lib/provider-response-history'

async function checkModule(pin: ArchivedAlbumReplayInput['adapter']) {
  if (archiveSha256(await readFile(pin.path)) !== pin.sha256)
    throw new Error('Replay module changed after review')
}

async function readModule(pin: ArchivedAlbumReplayInput['adapter']) {
  const moduleValue: unknown = await import(pathToFileURL(pin.path).href)
  if (typeof moduleValue !== 'object' || moduleValue === null)
    throw new Error('Invalid replay module')
  return 'default' in moduleValue
    ? moduleValue.default
    : 'plugin' in moduleValue
      ? moduleValue.plugin
      : null
}

export async function mapArchivedAlbum(input: ArchivedAlbumReplayInput) {
  await Promise.all(
    [input.adapter, input.projector, ...input.dependencies].map(checkModule),
  )
  const adapter = await readModule(input.adapter)
  const projector = await readModule(input.projector)
  if (
    !isMediaProviderPlugin(adapter) ||
    adapter.manifest.id !== input.provider ||
    !adapter.manifest.localWorkerRequired ||
    !adapter.manifest.mediaTypes.includes('album') ||
    !adapter.scrapeMediaItem ||
    typeof projector !== 'function'
  )
    throw new Error('This adapter cannot replay the reviewed album')

  let projectedResponses = 0
  const localBodies = new Map(
    input.localBodies.map(({ ordinal, archive }) => [ordinal, archive]),
  )
  if (localBodies.size !== input.localBodies.length)
    throw new Error('Archived response has duplicate local bodies')
  const replay = createProviderResponseReplay(input.captures, {
    async projectNativeResponse(capture, request) {
      const body = capture.response.body
      if (capture.response.status !== 200 || body.state === 'unavailable')
        throw new Error('Archived native response is unavailable')
      const url = new URL(request)
      const requestKey = archiveSha256(url.href)
      if (
        capture.ordinal === input.boundDetail.ordinal &&
        requestKey !== input.boundDetail.requestKey
      )
        throw new Error('Archive request differs from the reviewed detail')
      let text
      if (body.state === 'captured') text = body.text
      else {
        const retained = localBodies.get(capture.ordinal)
        if (
          !retained ||
          retained.id !== body.reference ||
          retained.retainedBytes !== body.retainedBytes ||
          retained.requestKey !== requestKey
        )
          throw new Error(
            'Archived local response differs from the original request',
          )
        text = retained.text
        localBodies.delete(capture.ordinal)
      }
      const source: unknown = JSON.parse(text)
      const projected: unknown = await projector(source, url)
      projectedResponses += 1
      return Response.json(JsonValueSchema.parse(projected))
    },
  })

  const artistProfiles = []
  for (const { id, name, providerArtistId } of input.artistLookups) {
    if (!adapter.scrapeArtist || !adapter.manifest.bootstrapAlbumArtists)
      throw new Error('Archived artist lookup does not match the adapter')
    try {
      const result = PluginArtistResultSchema.parse(
        await adapter.scrapeArtist({
          artist: { id, name },
          providerArtistId,
          request: replay.requestFor('artist'),
          secrets: {},
        }),
      )
      artistProfiles.push({ artistId: id, name, payload: result.payload })
    } catch (error) {
      // The ordinary album job can continue after an artist lookup miss.
      if (
        !isProviderItemNotFoundError(error) &&
        !isProviderItemAmbiguousError(error)
      )
        throw error
    }
  }
  const result = PluginResultSchema.parse(
    await adapter.scrapeMediaItem({
      mediaType: 'album',
      mediaItemId: input.albumId,
      media: input.media,
      options: input.options,
      existingReferences: input.existingReferences,
      artistProfiles: artistProfiles.length ? artistProfiles : undefined,
      isRejectedMatch: createAlbumMatchRejectionPredicate(
        input.provider,
        input.rejections,
      ),
      request: replay.requestFor('media'),
      secrets: {},
      log: async () => undefined,
    }),
  )
  replay.assertComplete()
  if (projectedResponses !== input.captures.length || localBodies.size)
    throw new Error('Every archived response must be native worker evidence')
  const [reference] = result.normalized.references
  if (
    result.normalized.references.length !== 1 ||
    reference?.referenceType !== 'group' ||
    reference.externalId !== input.groupId ||
    !reference.isPrimary
  )
    throw new Error('Archived replay did not select the reviewed group')
  return result
}

async function main() {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid replay input')
    bytes += chunk.length
    if (bytes > 64 * 1024 * 1024) throw new Error('Replay input is too large')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // The parent also runs this process inside an OS network sandbox.
  globalThis.fetch = async () => {
    throw new Error('Network requests are disabled for archived replay')
  }
  const result = await mapArchivedAlbum(
    ArchivedAlbumReplayInputSchema.parse(value),
  )
  process.stdout.write(JSON.stringify(result))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main().catch(() => {
    process.stderr.write('The isolated adapter could not replay the archive.\n')
    process.exitCode = 1
  })

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  archiveSha256,
  ArchivedAlbumReplayInputSchema,
  ArchivedAlbumReplayPlanSchema,
  verifyArchivedGroupReview,
} from './archived-album-replay'
import { runIsolatedArchivedReplay } from './archived-album-replay-process'
import { nativeProviderReplayRequestKey } from './provider-response-history'

const digest = archiveSha256('fixture')
const url = 'https://example.test/detail?id=42'
const requestKey = archiveSha256(url)
const scope = {
  jobId: 'job',
  jobItemId: 'item',
  attempt: 1,
  provider: 'fixture',
  albumId: 'album',
  groupId: '42',
}
const detail = {
  responseId: 'detail',
  ordinal: 2,
  requestKey,
  bodySha256: digest,
}
const anchor = {
  provider: 'spotify',
  referenceType: 'album',
  recordId: 'edition',
  snapshotId: 'snapshot',
  snapshotProvider: 'spotify',
  evidence: { title: 'Fixture', artists: ['Artist'], completeTracks: 1 },
}
const manifest = {
  version: 1,
  ...scope,
  decisionSha256: digest,
  anchors: [anchor],
  reviewedResultSha256: digest,
  detail,
}
function fixturePlan(bytes: Buffer) {
  return ArchivedAlbumReplayPlanSchema.parse({
    version: 3,
    ...scope,
    adapter: { path: '/fixture/adapter', sha256: digest },
    projector: { path: '/fixture/projector', sha256: digest },
    dependencies: [],
    library: {
      title: 'Fixture',
      date: '1999-01-01',
      artists: ['Artist'],
      tracks: ['Track'],
    },
    anchors: [anchor],
    originals: [
      { responseId: 'browse', sha256: digest },
      { responseId: 'detail', sha256: digest },
    ],
    detail: {
      responseId: detail.responseId,
      ordinal: detail.ordinal,
      requestUrl: url,
      archiveRequestKey: requestKey,
      notFoundOn404: true,
    },
    review: {
      evidenceFile: { path: '/fixture/evidence', sha256: archiveSha256(bytes) },
      decisionSha256: digest,
    },
    reviewedResultSha256: digest,
  })
}

it('binds the separately approved evidence to the failed item, detail, outcome and source anchors', () => {
  const bytes = Buffer.from(JSON.stringify(manifest))
  const plan = fixturePlan(bytes)
  if (plan.version !== 3) throw new Error('Expected reviewed group plan')
  expect(() => verifyArchivedGroupReview(plan, bytes)).not.toThrow()
  expect(() =>
    verifyArchivedGroupReview(plan, Buffer.from('changed')),
  ).toThrow()
  for (const changed of [
    { groupId: '43' },
    { jobItemId: 'other-item' },
    { attempt: 2 },
    { detail: { ...detail, ordinal: 1 } },
    { detail: { ...detail, responseId: 'browse' } },
    { detail: { ...detail, bodySha256: archiveSha256('other body') } },
    { detail: { ...detail, requestKey: archiveSha256('other request') } },
    { anchors: [{ ...anchor, recordId: 'swapped' }] },
    { reviewedResultSha256: archiveSha256('different result') },
  ]) {
    const other = Buffer.from(JSON.stringify({ ...manifest, ...changed }))
    const pinned = fixturePlan(other)
    if (pinned.version !== 3) throw new Error('Expected reviewed group plan')
    expect(() => verifyArchivedGroupReview(pinned, other)).toThrow(
      'The reviewed group evidence does not match the plan.',
    )
  }
})

it.skipIf(process.platform !== 'darwin')(
  'replays only the declared original detail and refuses contradictory references, groups and request keys',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reviewed-group-fixture-'))
    const pin = async (filename: string, text: string) => {
      const path = join(directory, filename)
      await writeFile(path, text, { mode: 0o600, flag: 'wx' })
      return { path, sha256: archiveSha256(text) }
    }
    try {
      const adapter = await pin(
        'adapter.mjs',
        `
        import { createServer } from 'node:net'
        export default {
          manifest: {
            id: 'fixture', displayName: 'Fixture', description: '',
            mediaTypes: ['album'], localWorkerRequired: true,
            localWorker: { origin: 'https://example.test', paths: ['/detail'], credentialHeaders: [], queryParameters: ['id'] },
            rateLimit: { maxConcurrent: 1, minTimeMs: 0 }, secrets: [],
          },
          async scrapeMediaItem({ request, existingReferences }) {
            const ref = existingReferences.find(item => item.metadata?.sourceProvider === 'fixture')
            if (!ref) throw Error('Adapter needs the explicitly reviewed group reference')
            await new Promise((resolve, reject) => {
              const server = createServer()
              server.once('error', resolve)
              server.listen(0, '127.0.0.1', () => server.close(() => reject(Error('Sandbox allowed network'))))
            })
            const result = await (await request(
              'https://example.test/detail?id=' + ref.externalId,
              { method: 'GET' },
              { requireLocalTransport: true, notFoundOn404: true },
            )).json()
            return {
              payload: result,
              normalized: { references: [{ referenceType: 'group', externalId: result.group, isPrimary: true }] },
            }
          },
        }
      `,
      )
      const projector = await pin('projector.mjs', 'export default raw => raw')
      const response = JSON.stringify({ group: '42' })
      const archiveId = '00000000-0000-4000-8000-000000000001'
      const input = ArchivedAlbumReplayInputSchema.parse({
        ...scope,
        adapter,
        projector,
        dependencies: [],
        artistLookups: [],
        media: {
          title: 'Fixture',
          artists: ['Artist'],
          releaseDate: '1999-01-01',
          releaseHints: [],
        },
        existingReferences: [],
        rejections: [],
        options: {},
        reviewedGroup: true,
        captures: [
          {
            ordinal: 2,
            phase: 'media',
            request: {
              method: 'GET',
              url: null,
              key: nativeProviderReplayRequestKey(url, true),
            },
            response: {
              status: 200,
              contentType: 'application/json',
              receivedAt: null,
              body: {
                state: 'local',
                reference: archiveId,
                retainedBytes: Buffer.byteLength(response),
              },
            },
          },
        ],
        localBodies: [
          {
            ordinal: 2,
            archive: {
              version: 1,
              id: archiveId,
              action: 'detail',
              status: 200,
              capturedAt: 1,
              retainedBytes: Buffer.byteLength(response),
              requestKey,
              sha256: archiveSha256(response),
              redacted: true,
              text: response,
            },
          },
        ],
        boundDetail: {
          ordinal: 2,
          requestKey,
          bodySha256: archiveSha256(response),
        },
      })
      await expect(runIsolatedArchivedReplay(input)).resolves.toMatchObject({
        payload: { group: '42' },
      })
      for (const changed of [
        { groupId: '43' },
        { boundDetail: { ...input.boundDetail, ordinal: 1 } },
        {
          boundDetail: {
            ...input.boundDetail,
            bodySha256: archiveSha256('swapped body'),
          },
        },
        {
          boundDetail: {
            ordinal: 2,
            requestKey: archiveSha256('swapped request'),
          },
        },
        {
          existingReferences: [
            {
              referenceType: 'group',
              externalId: '43',
              isPrimary: true,
              metadata: { sourceProvider: 'fixture' },
            },
          ],
        },
        {
          rejections: [
            {
              provider: 'fixture',
              sourceProvider: 'fixture',
              referenceType: 'group',
              identifier: '42',
              aliases: [],
            },
          ],
        },
        {
          artistLookups: [
            { id: 'artist', name: 'Artist', providerArtistId: null },
          ],
        },
        { captures: [...input.captures, ...input.captures] },
      ]) {
        await expect(
          runIsolatedArchivedReplay({ ...input, ...changed }),
        ).rejects.toThrow(
          'The network-isolated adapter could not reproduce the reviewed album.',
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

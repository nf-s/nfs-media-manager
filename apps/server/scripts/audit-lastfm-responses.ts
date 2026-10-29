import { and, asc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { isJsonRecord } from '@/lib/provider-normalizers'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { providerSnapshot } from '@/schemas/db'

const IdentitySchema = z.object({
  name: z.string(),
  artist: z.union([z.string(), z.object({ name: z.string() })]),
})

async function main() {
  const scrape = lastfmPlugin.scrapeMediaItem
  if (!scrape) throw new Error('Last.fm adapter is unavailable')
  globalThis.fetch = async () => {
    throw new Error('Live requests are forbidden in the saved-response audit')
  }
  const summary = new Map<string, { passed: number; failed: number }>()
  const failures = new Map<string, { count: number; examples: string[] }>()
  await db.transaction(
    async (tx) => {
      let cursor: string | undefined
      for (;;) {
        const rows = await tx
          .select({
            id: providerSnapshot.id,
            source: providerSnapshot.source,
            payload: providerSnapshot.payload,
          })
          .from(providerSnapshot)
          .where(
            and(
              eq(providerSnapshot.provider, 'lastfm'),
              cursor ? gt(providerSnapshot.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(providerSnapshot.id))
          .limit(100)
        if (!rows.length) break
        for (const row of rows) {
          const counts = summary.get(row.source) ?? { passed: 0, failed: 0 }
          summary.set(row.source, counts)
          const album =
            isJsonRecord(row.payload) && 'album' in row.payload
              ? row.payload['album']
              : row.payload
          try {
            const identity = IdentitySchema.parse(album)
            const result = await scrape({
              mediaItemId: 'offline-audit',
              mediaType: 'album',
              media: {
                title: identity.name,
                artists: [
                  typeof identity.artist === 'string'
                    ? identity.artist
                    : identity.artist.name,
                ],
              },
              existingReferences: [],
              secrets: { apiKey: 'offline-audit-placeholder' },
              request: async () => Response.json({ album }),
              log: async () => undefined,
            })
            if (!result.normalized) throw new Error('Missing normalized result')
            counts.passed += 1
          } catch (error) {
            counts.failed += 1
            const signature =
              error instanceof z.ZodError
                ? JSON.stringify(
                    error.issues.map((issue) => ({
                      path: issue.path,
                      code: issue.code,
                      message: issue.message,
                    })),
                  )
                : error instanceof Error
                  ? error.name
                  : 'UnknownError'
            const failure = failures.get(signature) ?? {
              count: 0,
              examples: [],
            }
            failure.count += 1
            if (failure.examples.length < 5) failure.examples.push(row.id)
            failures.set(signature, failure)
          }
        }
        cursor = rows.at(-1)?.id
        if (!cursor) break
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
  process.stdout.write(
    JSON.stringify(
      {
        sources: Object.fromEntries(summary),
        failures: Object.fromEntries(failures),
      },
      null,
      2,
    ) + '\n',
  )
  if (failures.size) process.exitCode = 1
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Audit failed') + '\n',
    )
    process.exitCode = 1
  })
  .finally(() => db.$client.end())

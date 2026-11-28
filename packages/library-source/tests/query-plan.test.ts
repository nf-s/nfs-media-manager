import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  openDeviceStore,
  served,
  trackQuery,
  type DeviceStore,
  type StoreRow,
} from './device-store'
import { tagPayload, trackRow } from './fixtures'

/** Synthetic rows only. */

const PlanRowSchema = z.object({ detail: z.string() })

function library(): StoreRow[] {
  const rows: StoreRow[] = [
    { entity: 'tag', id: 'tag-1', payload: tagPayload({ name: 'Ambient' }) },
    {
      entity: 'tag_key',
      id: 'album:dark ambient',
      payload: {
        mediaType: 'album',
        key: 'dark ambient',
        ancestorKeys: ['ambient'],
      },
    },
  ]
  for (let index = 0; index < 200; index += 1) {
    rows.push({
      entity: 'track',
      id: `track-${index}`,
      payload: trackRow(`track-${index}`, {
        num: { dateAdded: 1_700_000_000_000_000 + index },
        extra: {
          recording: { key: index % 3 === 0 ? `rec-${index % 30}` : null },
        },
      }),
    })
  }
  return rows
}

let store: DeviceStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** The plan of the statement that reads the rows of the last call. */
async function planOfLastRead(device: DeviceStore): Promise<string[]> {
  const main = [...device.statements]
    .reverse()
    .find((statement) => /ORDER BY[\s\S]*LIMIT/u.test(statement.sql))
  if (main === undefined) throw new Error('No ordered read was run.')
  const rows = await device.driver.all(`EXPLAIN QUERY PLAN ${main.sql}`, [
    ...main.params,
  ])
  return rows.map((row) => PlanRowSchema.parse(row).detail)
}

async function planFor(input: Record<string, unknown>) {
  store = await openDeviceStore(library())
  store.statements.length = 0
  served(await store.source.trackPage(trackQuery(input)))
  return planOfLastRead(store)
}

describe('query plans', () => {
  it('walks the Added index for the first page and sorts only the ties', async () => {
    const plan = (await planFor({})).join('\n')
    expect(plan).toMatch(
      /SEARCH t USING INDEX track_date_added \(archived=\?\)/u,
    )
    expect(plan).toMatch(/USE TEMP B-TREE FOR LAST \d+ TERMS OF ORDER BY/u)
  })

  it('gives each search word of three or more characters to the trigram index', async () => {
    const plan = (await planFor({ q: 'track example album' })).join('\n')
    expect(plan.match(/SCAN f VIRTUAL TABLE INDEX 0:G/gu)).toHaveLength(6)
    expect(plan).toMatch(/SEARCH v USING INTEGER PRIMARY KEY/u)
  })

  it('reads tag carriers through the tag index', async () => {
    const plan = await planFor({
      filters: [{ field: 'genre', value: 'ambient', mode: 'required' }],
    })
    expect(plan.join('\n')).toMatch(
      /SEARCH item_tag USING COVERING INDEX item_tag_tag \(tag_id=\? AND entity=\? AND level=\?\)/u,
    )
  })

  it('reads play times by key from the names of each track for a period sort', async () => {
    const plan = (await planFor({ sortBy: 'listeningScrobbles' })).join('\n')
    expect(plan).toMatch(/SEARCH tn USING PRIMARY KEY \(rid=\?\)/u)
    expect(plan).toMatch(
      /SEARCH ps USING COVERING INDEX sqlite_autoindex_play_set_1 \(entity=\? AND id=\?\)/u,
    )
    expect(plan).toMatch(/SEARCH p USING PRIMARY KEY \(pid=\? AND played_at/u)
  })

  it('reads the matching tracks once for a grouped page', async () => {
    const plan = (await planFor({ groupRecordings: true })).join('\n')
    expect(plan.match(/MATERIALIZE matches/gu)).toHaveLength(1)
    expect(plan).toMatch(
      /SEARCH track USING INDEX sqlite_autoindex_track_1 \(id=\?\)/u,
    )
  })
})

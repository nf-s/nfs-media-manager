import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getJobTask, type Job, type JobSubject } from '@repo/schemas/job'
import {
  SONOVAULT_SIMILAR_LOOKUP_TASK,
  SONOVAULT_TRACK_LOOKUP_TASK,
} from '@repo/schemas/sonovault'
import { SONOVAULT_ALBUM_LOOKUP_TASK } from '@repo/schemas/sonovault-album'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'

const SubjectRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  artists: z.string().nullable(),
})

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : null

/**
 * The library item a task job's options name: the album an album lookup
 * reads, the item whose similar items are read, the track a match is for, or
 * the first track of a bulk lookup. Null for other jobs.
 */
export function jobSubjectId(options: Record<string, unknown>): string | null {
  switch (getJobTask(options)) {
    case SONOVAULT_ALBUM_LOOKUP_TASK:
      return text(options.albumId)
    case TIDAL_SIMILAR_TASK:
    case SPOTIFY_SIMILAR_LOOKUP_TASK:
    case SONOVAULT_SIMILAR_LOOKUP_TASK:
      return text(options.itemId)
    case TIDAL_TRACK_MATCH_TASK:
      return text(options.trackId)
    case SONOVAULT_TRACK_LOOKUP_TASK:
      return Array.isArray(options.trackIds) ? text(options.trackIds[0]) : null
    default:
      return null
  }
}

/**
 * Adds each task job's subject, its title and credited artists, with one
 * query for all of them, so a job's name says what it is about.
 */
export async function withJobSubjects(jobs: Job[]): Promise<Job[]> {
  const ids = [
    ...new Set(jobs.flatMap((job) => jobSubjectId(job.options) ?? [])),
  ]
  if (!ids.length) return jobs
  const rows = z.array(SubjectRowSchema).parse(
    (
      await db.execute(sql`select mi.id, mi.title, (
          select string_agg(a.name, ', ' order by c.billing_order, a.name)
          from media_credit c join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist') as artists
        from media_item mi
        where mi.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    ).rows,
  )
  const subjects = new Map(
    rows.map((row): [string, JobSubject] => [
      row.id,
      { title: row.title, artists: row.artists },
    ]),
  )
  return jobs.map((job) => {
    const id = jobSubjectId(job.options)
    return id ? { ...job, subject: subjects.get(id) ?? null } : job
  })
}

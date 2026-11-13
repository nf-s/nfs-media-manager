import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { JsonValue } from '@repo/media-plugin-sdk'
export * from './auth'
import { user } from './auth'

const mediaTypeEnum = pgEnum('media_type', ['album', 'film', 'track'])
const playlistKindEnum = pgEnum('playlist_kind', ['playlist', 'collection'])
const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

const timestampColumns = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
}

export const mediaItem = pgTable(
  'media_item',
  {
    id: text('id').primaryKey(),
    mediaType: mediaTypeEnum('media_type').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    originalTitle: text('original_title'),
    summary: text('summary'),
    artworkUrl: text('artwork_url'),
    releaseDate: timestamp('release_date', {
      mode: 'date',
      withTimezone: false,
    }),
    sourceLabel: text('source_label'),
    metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('media_item_slug_uidx').on(table.slug),
    index('media_item_type_idx').on(table.mediaType),
    index('media_item_title_idx').on(table.title),
    index('media_item_type_title_id_idx').on(
      table.mediaType,
      sql`lower(${table.title})`,
      table.id,
    ),
  ],
)

export const album = pgTable('album', {
  mediaItemId: text('media_item_id')
    .primaryKey()
    .references(() => mediaItem.id, { onDelete: 'cascade' }),
  dateAdded: timestamp('date_added', {
    mode: 'date',
    withTimezone: false,
  }),
  durationSec: integer('duration_sec'),
  trackCount: integer('track_count').default(0).notNull(),
  spotifyUrl: text('spotify_url'),
  metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
  ...timestampColumns,
})

export const film = pgTable('film', {
  mediaItemId: text('media_item_id')
    .primaryKey()
    .references(() => mediaItem.id, { onDelete: 'cascade' }),
  dateAdded: timestamp('date_added'),
  dateAddedSource: text('date_added_source'),
  runtimeMinutes: integer('runtime_minutes'),
  watched: boolean('watched').default(false).notNull(),
  sourceKind: text('source_kind'),
  budget: integer('budget'),
  boxOffice: integer('box_office'),
  metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
  ...timestampColumns,
})

export const track = pgTable(
  'track',
  {
    id: text('id').primaryKey(),
    albumMediaItemId: text('album_media_item_id')
      .notNull()
      .references(() => album.mediaItemId, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    durationSec: integer('duration_sec'),
    metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('track_album_position_uidx').on(
      table.albumMediaItemId,
      table.position,
    ),
  ],
)

// A track in the track library, imported from a playlist. It is separate from
// an album's track list above: its album may not be in the library.
export const libraryTrack = pgTable(
  'library_track',
  {
    mediaItemId: text('media_item_id')
      .primaryKey()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    spotifyTrackId: text('spotify_track_id').notNull(),
    isrc: text('isrc'),
    durationSec: integer('duration_sec'),
    // The earliest date the track was added to an imported playlist.
    dateAdded: timestamp('date_added', {
      mode: 'date',
      withTimezone: false,
    }),
    spotifyUrl: text('spotify_url'),
    albumName: text('album_name'),
    spotifyAlbumId: text('spotify_album_id'),
    albumMediaItemId: text('album_media_item_id').references(
      () => album.mediaItemId,
      { onDelete: 'set null' },
    ),
    // How the library album was found: spotify-album, spotify-track, album-title or artist-title.
    albumLinkStrategy: text('album_link_strategy'),
    scrobbleCount: integer('scrobble_count').default(0).notNull(),
    lastListenedAt: timestamp('last_listened_at', {
      mode: 'date',
      withTimezone: false,
    }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('library_track_spotify_track_uidx').on(table.spotifyTrackId),
    index('library_track_album_idx').on(table.albumMediaItemId),
    index('library_track_spotify_album_idx').on(table.spotifyAlbumId),
  ],
)

export const artist = pgTable(
  'artist',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortName: text('sort_name'),
    ...timestampColumns,
  },
  (table) => [uniqueIndex('artist_name_uidx').on(table.name)],
)

export const mediaCredit = pgTable(
  'media_credit',
  {
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    artistId: text('artist_id')
      .notNull()
      .references(() => artist.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    billingOrder: integer('billing_order').default(0).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaItemId, table.artistId, table.role],
    }),
  ],
)

export const tag = pgTable(
  'tag',
  {
    id: text('id').primaryKey(),
    mediaType: mediaTypeEnum('media_type').notNull(),
    name: text('name').notNull(),
    kind: text('kind').default('general').notNull(),
    hidden: boolean('hidden').default(false).notNull(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('tag_media_type_name_kind_uidx').on(
      table.mediaType,
      table.name,
      table.kind,
    ),
  ],
)

export const mediaItemTag = pgTable(
  'media_item_tag',
  {
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.mediaItemId, table.tagId] }),
    index('media_item_tag_tag_media_idx').on(table.tagId, table.mediaItemId),
  ],
)

export const tagIdentity = pgTable(
  'tag_identity',
  {
    mediaType: mediaTypeEnum('media_type').notNull(),
    normalizedName: text('normalized_name').notNull(),
    kind: text('kind').notNull(),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaType, table.normalizedName, table.kind],
    }),
    index('tag_identity_tag_idx').on(table.tagId),
  ],
)

export const tagAlias = pgTable(
  'tag_alias',
  {
    sourceTagId: text('source_tag_id')
      .primaryKey()
      .references(() => tag.id),
    targetTagId: text('target_tag_id')
      .notNull()
      .references(() => tag.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('tag_alias_target_idx').on(table.targetTagId),
    check(
      'tag_alias_not_self',
      sql`${table.sourceTagId} <> ${table.targetTagId}`,
    ),
  ],
)

export const tagOccurrence = pgTable(
  'tag_occurrence',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    provider: text('provider'),
    source: text('source'),
    sourceId: text('source_id'),
    rawName: text('raw_name').notNull(),
    kind: text('kind').notNull(),
    ...timestampColumns,
  },
  (table) => [
    index('tag_occurrence_tag_idx').on(table.tagId),
    index('tag_occurrence_media_idx').on(table.mediaItemId),
    index('tag_occurrence_tag_media_kind_idx').on(
      table.tagId,
      table.mediaItemId,
      table.kind,
    ),
  ],
)

export const tagMerge = pgTable('tag_merge', {
  id: text('id').primaryKey(),
  sourceTagId: text('source_tag_id')
    .notNull()
    .references(() => tag.id),
  targetTagId: text('target_tag_id')
    .notNull()
    .references(() => tag.id),
  requestedByUserId: text('requested_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const playlist = pgTable(
  'playlist',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: playlistKindEnum('kind').notNull(),
    // spotify or spotify-liked for an imported playlist; null otherwise.
    source: text('source'),
    spotifyId: text('spotify_id'),
    ownerName: text('owner_name'),
    description: text('description'),
    artworkUrl: text('artwork_url'),
    spotifyUrl: text('spotify_url'),
    // Spotify's version of the playlist contents at the last import.
    snapshotId: text('snapshot_id'),
    importedAt: timestamp('imported_at'),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('playlist_name_kind_uidx').on(table.name, table.kind),
    uniqueIndex('playlist_spotify_id_uidx').on(table.spotifyId),
  ],
)

export const playlistItem = pgTable(
  'playlist_item',
  {
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlist.id, { onDelete: 'cascade' }),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    position: integer('position').default(0).notNull(),
    addedAt: timestamp('added_at', { mode: 'date', withTimezone: false }),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.mediaItemId] }),
    index('playlist_item_media_item_idx').on(table.mediaItemId),
  ],
)

export const libraryImport = pgTable('library_import', {
  id: text('id').primaryKey(),
  status: jobStatusEnum('status').notNull(),
  stage: text('stage').notNull(),
  processed: integer('processed').notNull().default(0),
  total: integer('total').notNull().default(0),
  errorMessage: text('error_message'),
  result: jsonb('result').$type<{
    albums: number
    films: number
    mediaType?: 'album' | 'film' | null
    skipped?: number
    failed?: number
    warnings?: string[]
    jobBatchId?: string
    queuedJobs?: number
    skippedJobs?: number
  }>(),
  requestedByUserId: text('requested_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
  finishedAt: timestamp('finished_at'),
  ...timestampColumns,
})

export const filmImportPreview = pgTable('film_import_preview', {
  id: text('id').primaryKey(),
  requestedByUserId: text('requested_by_user_id').references(() => user.id, {
    onDelete: 'cascade',
  }),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  records: jsonb('records').$type<JsonValue>().notNull(),
  claimed: boolean('claimed').notNull().default(false),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const providerRequestState = pgTable('provider_request_state', {
  requestBudgetOverride: jsonb('request_budget_override').$type<JsonValue>(),
  budgetUpdatedByUserId: text('budget_updated_by_user_id').references(
    () => user.id,
    { onDelete: 'set null' },
  ),
  historyStartedAt: timestamp('history_started_at').defaultNow().notNull(),
  halted: boolean('halted').notNull().default(false),
  provider: text('provider').primaryKey(),
  requests: jsonb('requests').$type<number[]>().notNull().default([]),
  nextAllowedAt: timestamp('next_allowed_at'),
  cooldownUntil: timestamp('cooldown_until'),
  failureCount: integer('failure_count').notNull().default(0),
  leaseId: text('lease_id'),
  leaseUntil: timestamp('lease_until'),
  requestLeases: jsonb('request_leases')
    .$type<Array<{ id: string; expiresAt: number }>>()
    .notNull()
    .default([]),
  lastError: text('last_error'),
  ...timestampColumns,
})

export const providerRequestEvent = pgTable(
  'provider_request_event',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    requestedAt: timestamp('requested_at').notNull(),
    requestClass: text('request_class').notNull().default('read'),
  },
  (table) => [
    index('provider_request_event_provider_time_idx').on(
      table.provider,
      table.requestedAt,
    ),
    index('provider_request_event_class_time_idx').on(
      table.provider,
      table.requestClass,
      table.requestedAt,
    ),
  ],
)

export const providerCooldownReset = pgTable(
  'provider_cooldown_reset',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    previousCooldownUntil: timestamp('previous_cooldown_until').notNull(),
    clearedAt: timestamp('cleared_at').defaultNow().notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('provider_cooldown_reset_provider_time_idx').on(
      table.provider,
      table.clearedAt,
    ),
  ],
)

export const externalLink = pgTable(
  'external_link',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    ...timestampColumns,
  },
  (table) => [index('external_link_media_item_idx').on(table.mediaItemId)],
)

export const providerReference = pgTable(
  'provider_reference',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    referenceType: text('reference_type').notNull(),
    externalId: text('external_id').notNull(),
    isPrimary: boolean('is_primary').default(false).notNull(),
    metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('provider_reference_media_item_provider_external_uidx').on(
      table.mediaItemId,
      table.provider,
      table.referenceType,
      table.externalId,
    ),
    index('provider_reference_media_item_idx').on(table.mediaItemId),
    index('provider_reference_identity_idx').on(
      table.referenceType,
      table.externalId,
    ),
  ],
)

export const scrapeJob = pgTable(
  'scrape_job',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    status: jobStatusEnum('status').default('queued').notNull(),
    scope: jsonb('scope').$type<Record<string, JsonValue>>().notNull(),
    options: jsonb('options').$type<Record<string, JsonValue>>().notNull(),
    confirmBroadRun: boolean('confirm_broad_run').default(false).notNull(),
    errorMessage: text('error_message'),
    requestedByUserId: text('requested_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', {
      mode: 'date',
      withTimezone: false,
    }),
    finishedAt: timestamp('finished_at', {
      mode: 'date',
      withTimezone: false,
    }),
    ...timestampColumns,
  },
  (table) => [
    index('scrape_job_status_idx').on(table.status),
    index('scrape_job_provider_idx').on(table.provider),
    index('scrape_job_dispatch_idx').on(
      table.provider,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('scrape_job_queued_provider_idx').on(table.status, table.provider),
  ],
)

export const scrapeJobItem = pgTable(
  'scrape_job_item',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => scrapeJob.id, { onDelete: 'cascade' }),
    mediaItemId: text('media_item_id').references(() => mediaItem.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    status: jobStatusEnum('status').default('queued').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    message: text('message'),
    payload: jsonb('payload').$type<JsonValue>(),
    startedAt: timestamp('started_at', {
      mode: 'date',
      withTimezone: false,
    }),
    finishedAt: timestamp('finished_at', {
      mode: 'date',
      withTimezone: false,
    }),
    ...timestampColumns,
  },
  (table) => [
    index('scrape_job_item_job_idx').on(table.jobId),
    index('scrape_job_item_latest_idx').on(
      table.provider,
      table.mediaItemId,
      table.startedAt.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('scrape_job_item_media_history_idx').on(
      table.mediaItemId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
)

export const scrapeJobLog = pgTable(
  'scrape_job_log',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => scrapeJob.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('scrape_job_log_job_idx').on(table.jobId)],
)

export const providerSnapshot = pgTable(
  'provider_snapshot',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id').references(() => mediaItem.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    checksum: text('checksum').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    normalizedData: jsonb('normalized_data').$type<Record<string, JsonValue>>(),
    source: text('source').notNull(),
    scrapeJobId: text('scrape_job_id').references(() => scrapeJob.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('provider_snapshot_media_item_idx').on(table.mediaItemId),
    index('provider_snapshot_provider_idx').on(table.provider),
    index('provider_snapshot_job_time_idx').on(
      table.scrapeJobId,
      table.createdAt,
      table.id,
    ),
    index('provider_snapshot_media_time_idx').on(
      table.mediaItemId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
)

export const providerCurrentState = pgTable(
  'provider_current_state',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    latestSnapshotId: text('latest_snapshot_id').references(
      () => providerSnapshot.id,
      { onDelete: 'set null' },
    ),
    checksum: text('checksum').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    normalizedData: jsonb('normalized_data').$type<Record<string, JsonValue>>(),
    status: text('status').notNull(),
    lastSuccessfulAt: timestamp('last_successful_at', {
      mode: 'date',
      withTimezone: false,
    }),
    lastScrapedAt: timestamp('last_scraped_at'),
    ...timestampColumns,
  },
  (table) => [
    index('provider_current_state_freshness_idx').on(
      table.provider,
      table.lastScrapedAt,
    ),
    uniqueIndex('provider_current_state_media_item_provider_uidx').on(
      table.mediaItemId,
      table.provider,
    ),
  ],
)

export const mediaOverride = pgTable(
  'media_override',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    value: jsonb('value').$type<JsonValue>().notNull(),
    note: text('note'),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestampColumns,
  },
  (table) => [index('media_override_media_item_idx').on(table.mediaItemId)],
)

export const providerReferenceOverride = pgTable(
  'provider_reference_override',
  {
    id: text('id').primaryKey(),
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    referenceType: text('reference_type').notNull(),
    externalId: text('external_id').notNull(),
    note: text('note'),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestampColumns,
  },
  (table) => [
    index('provider_reference_override_media_item_idx').on(table.mediaItemId),
  ],
)

export const providerSecret = pgTable(
  'provider_secret',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    key: text('key').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', {
      mode: 'date',
      withTimezone: false,
    }),
    lastVerifiedStatus: text('last_verified_status'),
    lastUpdatedByUserId: text('last_updated_by_user_id').references(
      () => user.id,
      { onDelete: 'set null' },
    ),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('provider_secret_provider_key_uidx').on(
      table.provider,
      table.key,
    ),
  ],
)

export const lastfmScrobble = pgTable(
  'lastfm_scrobble',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    // UTC, as reported by Last.fm.
    listenedAt: timestamp('listened_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    artistName: text('artist_name').notNull(),
    albumName: text('album_name'),
    trackName: text('track_name').notNull(),
    artistKey: text('artist_key').notNull(),
    albumKey: text('album_key'),
    trackKey: text('track_key').notNull(),
    artistMbid: text('artist_mbid'),
    albumMbid: text('album_mbid'),
    trackMbid: text('track_mbid'),
    albumMediaItemId: text('album_media_item_id').references(
      () => album.mediaItemId,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('lastfm_scrobble_album_time_idx').on(
      table.albumMediaItemId,
      table.listenedAt,
    ),
    index('lastfm_scrobble_name_idx').on(table.albumKey, table.artistKey),
    index('lastfm_scrobble_user_time_idx').on(table.username, table.listenedAt),
    index('lastfm_scrobble_track_idx').on(table.trackKey, table.artistKey),
  ],
)

// How one scrobbled artist and album name links to a library album. An
// automatic row is recomputed on every relink; a manual row is kept, and a
// manual row without an album keeps the name unlinked.
export const lastfmAlbumLink = pgTable(
  'lastfm_album_link',
  {
    username: text('username').notNull(),
    artistKey: text('artist_key').notNull(),
    albumKey: text('album_key').notNull(),
    albumMediaItemId: text('album_media_item_id').references(
      () => album.mediaItemId,
      { onDelete: 'cascade' },
    ),
    // auto or manual.
    source: text('source').notNull(),
    strategy: text('strategy'),
    // Equally fitting albums when automatic matching could not choose.
    candidateIds: jsonb('candidate_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({
      columns: [table.username, table.artistKey, table.albumKey],
    }),
    index('lastfm_album_link_album_idx').on(table.albumMediaItemId),
  ],
)

// A scrobbled artist and track name counted towards a library track. One name
// can count towards several tracks when Spotify lists the recording twice.
// Rows are recomputed on every relink.
export const lastfmTrackLink = pgTable(
  'lastfm_track_link',
  {
    username: text('username').notNull(),
    artistKey: text('artist_key').notNull(),
    trackKey: text('track_key').notNull(),
    trackMediaItemId: text('track_media_item_id')
      .notNull()
      .references(() => libraryTrack.mediaItemId, { onDelete: 'cascade' }),
    strategy: text('strategy').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.username,
        table.artistKey,
        table.trackKey,
        table.trackMediaItemId,
      ],
    }),
    index('lastfm_track_link_track_idx').on(table.trackMediaItemId),
  ],
)

export const lastfmSync = pgTable('lastfm_sync', {
  username: text('username').primaryKey(),
  // running, failed, complete, or idle before the first run.
  status: text('status').notNull(),
  schedule: text('schedule').notNull().default('daily'),
  // Unix seconds. The window is fixed for a run so page numbers stay stable.
  windowFrom: bigint('window_from', { mode: 'number' }),
  windowTo: bigint('window_to', { mode: 'number' }).notNull(),
  nextPage: integer('next_page').notNull().default(1),
  totalPages: integer('total_pages'),
  newScrobbles: integer('new_scrobbles').notNull().default(0),
  syncedThrough: bigint('synced_through', { mode: 'number' }),
  errorMessage: text('error_message'),
  leaseToken: text('lease_token'),
  leaseUntil: timestamp('lease_until'),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
  requestedByUserId: text('requested_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
  ...timestampColumns,
})

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

export const youtubeChannel = pgTable(
  'youtube_channel',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    handle: text('handle'),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    uploadsPlaylistId: text('uploads_playlist_id'),
    subscriberCount: bigint('subscriber_count', { mode: 'number' }),
    // Cleared when a sync no longer lists the subscription; videos are kept.
    subscribed: boolean('subscribed').notNull().default(true),
    // The sync run that last listed the subscription.
    seenRunId: text('seen_run_id'),
    // Every page of the uploads playlist has been read at least once.
    historyComplete: boolean('history_complete').notNull().default(false),
    ...timestampColumns,
  },
  (table) => [
    index('youtube_channel_subscribed_idx').on(table.subscribed, table.id),
  ],
)

export const youtubeVideo = pgTable(
  'youtube_video',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => youtubeChannel.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    // UTC, as reported by YouTube.
    publishedAt: timestamp('published_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    durationSec: integer('duration_sec').notNull().default(0),
    viewCount: bigint('view_count', { mode: 'number' }),
    likeCount: bigint('like_count', { mode: 'number' }),
    commentCount: bigint('comment_count', { mode: 'number' }),
    // none, live or upcoming.
    live: text('live').notNull().default('none'),
    // Title (A), channel name and tags (B), description (D).
    search: tsvector('search').notNull(),
    ...timestampColumns,
  },
  (table) => [
    index('youtube_video_search_idx').using('gin', table.search),
    index('youtube_video_channel_published_idx').on(
      table.channelId,
      table.publishedAt,
    ),
    index('youtube_video_published_idx').on(table.publishedAt, table.id),
    index('youtube_video_views_idx').on(table.viewCount),
    index('youtube_video_duration_idx').on(table.durationSec),
  ],
)

export const youtubeSync = pgTable('youtube_sync', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // running, paused, failed, complete, or idle before the first run.
  status: text('status').notNull(),
  schedule: text('schedule').notNull().default('daily'),
  runId: text('run_id'),
  // subscriptions, then videos.
  phase: text('phase').notNull().default('subscriptions'),
  // Next page of the subscription list, or of the current channel's uploads.
  pageToken: text('page_token'),
  // The last channel whose uploads were read in this run.
  channelCursor: text('channel_cursor'),
  channelsDone: integer('channels_done').notNull().default(0),
  channelsTotal: integer('channels_total').notNull().default(0),
  newVideos: integer('new_videos').notNull().default(0),
  // When a run paused by the daily quota may continue.
  resumeAfter: timestamp('resume_after'),
  errorMessage: text('error_message'),
  leaseToken: text('lease_token'),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
  ...timestampColumns,
})

export const mediaItemRelations = relations(mediaItem, ({ many, one }) => ({
  album: one(album, {
    fields: [mediaItem.id],
    references: [album.mediaItemId],
  }),
  film: one(film, {
    fields: [mediaItem.id],
    references: [film.mediaItemId],
  }),
  libraryTrack: one(libraryTrack, {
    fields: [mediaItem.id],
    references: [libraryTrack.mediaItemId],
  }),
  credits: many(mediaCredit),
  tags: many(mediaItemTag),
  playlistItems: many(playlistItem),
  links: many(externalLink),
  providerReferences: many(providerReference),
  snapshots: many(providerSnapshot),
  currentStates: many(providerCurrentState),
  overrides: many(mediaOverride),
  referenceOverrides: many(providerReferenceOverride),
  jobItems: many(scrapeJobItem),
}))

export const albumRelations = relations(album, ({ one, many }) => ({
  mediaItem: one(mediaItem, {
    fields: [album.mediaItemId],
    references: [mediaItem.id],
  }),
  tracks: many(track),
}))

export const filmRelations = relations(film, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [film.mediaItemId],
    references: [mediaItem.id],
  }),
}))

export const libraryTrackRelations = relations(libraryTrack, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [libraryTrack.mediaItemId],
    references: [mediaItem.id],
  }),
  album: one(album, {
    fields: [libraryTrack.albumMediaItemId],
    references: [album.mediaItemId],
  }),
}))

export const trackRelations = relations(track, ({ one }) => ({
  album: one(album, {
    fields: [track.albumMediaItemId],
    references: [album.mediaItemId],
  }),
}))

export const artistRelations = relations(artist, ({ many }) => ({
  credits: many(mediaCredit),
}))

export const mediaCreditRelations = relations(mediaCredit, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [mediaCredit.mediaItemId],
    references: [mediaItem.id],
  }),
  artist: one(artist, {
    fields: [mediaCredit.artistId],
    references: [artist.id],
  }),
}))

export const tagRelations = relations(tag, ({ many }) => ({
  mediaItems: many(mediaItemTag),
}))

export const mediaItemTagRelations = relations(mediaItemTag, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [mediaItemTag.mediaItemId],
    references: [mediaItem.id],
  }),
  tag: one(tag, {
    fields: [mediaItemTag.tagId],
    references: [tag.id],
  }),
}))

export const playlistRelations = relations(playlist, ({ many }) => ({
  items: many(playlistItem),
}))

export const playlistItemRelations = relations(playlistItem, ({ one }) => ({
  playlist: one(playlist, {
    fields: [playlistItem.playlistId],
    references: [playlist.id],
  }),
  mediaItem: one(mediaItem, {
    fields: [playlistItem.mediaItemId],
    references: [mediaItem.id],
  }),
}))

export const externalLinkRelations = relations(externalLink, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [externalLink.mediaItemId],
    references: [mediaItem.id],
  }),
}))

export const providerReferenceRelations = relations(
  providerReference,
  ({ one }) => ({
    mediaItem: one(mediaItem, {
      fields: [providerReference.mediaItemId],
      references: [mediaItem.id],
    }),
  }),
)

export const scrapeJobRelations = relations(scrapeJob, ({ many, one }) => ({
  requestedBy: one(user, {
    fields: [scrapeJob.requestedByUserId],
    references: [user.id],
  }),
  items: many(scrapeJobItem),
  logs: many(scrapeJobLog),
  snapshots: many(providerSnapshot),
}))

export const scrapeJobItemRelations = relations(scrapeJobItem, ({ one }) => ({
  job: one(scrapeJob, {
    fields: [scrapeJobItem.jobId],
    references: [scrapeJob.id],
  }),
  mediaItem: one(mediaItem, {
    fields: [scrapeJobItem.mediaItemId],
    references: [mediaItem.id],
  }),
}))

export const scrapeJobLogRelations = relations(scrapeJobLog, ({ one }) => ({
  job: one(scrapeJob, {
    fields: [scrapeJobLog.jobId],
    references: [scrapeJob.id],
  }),
}))

export const providerSnapshotRelations = relations(
  providerSnapshot,
  ({ one }) => ({
    mediaItem: one(mediaItem, {
      fields: [providerSnapshot.mediaItemId],
      references: [mediaItem.id],
    }),
    job: one(scrapeJob, {
      fields: [providerSnapshot.scrapeJobId],
      references: [scrapeJob.id],
    }),
  }),
)

export const providerCurrentStateRelations = relations(
  providerCurrentState,
  ({ one }) => ({
    mediaItem: one(mediaItem, {
      fields: [providerCurrentState.mediaItemId],
      references: [mediaItem.id],
    }),
    latestSnapshot: one(providerSnapshot, {
      fields: [providerCurrentState.latestSnapshotId],
      references: [providerSnapshot.id],
    }),
  }),
)

export const mediaOverrideRelations = relations(mediaOverride, ({ one }) => ({
  mediaItem: one(mediaItem, {
    fields: [mediaOverride.mediaItemId],
    references: [mediaItem.id],
  }),
  createdBy: one(user, {
    fields: [mediaOverride.createdByUserId],
    references: [user.id],
  }),
}))

export const providerReferenceOverrideRelations = relations(
  providerReferenceOverride,
  ({ one }) => ({
    mediaItem: one(mediaItem, {
      fields: [providerReferenceOverride.mediaItemId],
      references: [mediaItem.id],
    }),
    createdBy: one(user, {
      fields: [providerReferenceOverride.createdByUserId],
      references: [user.id],
    }),
  }),
)

export const providerSecretRelations = relations(providerSecret, ({ one }) => ({
  updatedBy: one(user, {
    fields: [providerSecret.lastUpdatedByUserId],
    references: [user.id],
  }),
}))

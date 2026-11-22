import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type { JsonValue } from '@repo/media-plugin-sdk'
import type { ProviderResponseBody } from '@repo/schemas/provider-response'
import type {
  ArtistProfile,
  ArtistProviderId,
} from '@repo/schemas/artist-profiles'
import type { LibraryChangeDetails } from '@repo/schemas/library-changes'
import type { SpotifyCodeLookupSource } from '@repo/schemas/tidal'
export * from './auth'
import { user } from './auth'
import { normalizedTagSql } from '../lib/tag-sql'

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
    index('media_item_recording_title_idx').on(
      table.mediaType,
      sql`lower(trim(regexp_replace(${table.title}, '[[:space:]]+', ' ', 'g')))`,
    ),
    index('media_item_title_search_idx').using(
      'gin',
      table.title.op('gin_trgm_ops'),
    ),
    index('media_item_summary_search_idx').using(
      'gin',
      table.summary.op('gin_trgm_ops'),
    ),
    index('media_item_type_release_id_idx').on(
      table.mediaType,
      table.releaseDate.desc().nullsLast(),
      table.id,
    ),
    index('media_item_type_title_id_idx').on(
      table.mediaType,
      sql`lower(${table.title})`,
      table.id,
    ),
  ],
)

export const album = pgTable(
  'album',
  {
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
    // The album this one is an edition of: the first album of the record,
    // never an edition itself. Null for a first album.
    editionOfId: text('edition_of_id').references(
      (): AnyPgColumn => album.mediaItemId,
      { onDelete: 'set null' },
    ),
    ...timestampColumns,
  },
  (table) => [index('album_edition_of_idx').on(table.editionOfId)],
)

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

// An ordered membership with the original track-list fields supplied by the provider.
export const track = pgTable(
  'track',
  {
    id: text('id').primaryKey(),
    albumMediaItemId: text('album_media_item_id')
      .notNull()
      .references(() => album.mediaItemId, { onDelete: 'cascade' }),
    trackMediaItemId: text('track_media_item_id')
      .notNull()
      .references(() => libraryTrack.mediaItemId),
    externalId: text('external_id'),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    durationSec: integer('duration_sec'),
    metadata: jsonb('metadata').$type<Record<string, JsonValue>>(),
    ...timestampColumns,
  },
  (table) => [
    index('track_library_track_idx').on(table.trackMediaItemId),
    index('track_album_title_idx').on(
      table.albumMediaItemId,
      sql`lower(regexp_replace(trim(${table.title}), '[[:space:]]+', ' ', 'g'))`,
    ),
    uniqueIndex('track_album_position_uidx').on(
      table.albumMediaItemId,
      table.position,
    ),
  ],
)

// The recording shared by album track lists, playlists and stored Last.fm history.
export const libraryTrack = pgTable(
  'library_track',
  {
    mediaItemId: text('media_item_id')
      .primaryKey()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    spotifyTrackId: text('spotify_track_id'),
    isrc: text('isrc'),
    durationSec: integer('duration_sec'),
    // The earliest manual addition, playlist-added date or first imported scrobble.
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
    // Tracks joined as versions of one record share a group. A group of one
    // keeps a track apart from the versions worked out for it.
    versionGroupId: text('version_group_id'),
    // The version a record's row is shown as. At most one in a group.
    versionShown: boolean('version_shown').default(false).notNull(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('library_track_spotify_track_uidx').on(table.spotifyTrackId),
    index('library_track_version_group_idx')
      .on(table.versionGroupId)
      .where(sql`${table.versionGroupId} is not null`),
    uniqueIndex('library_track_version_shown_uidx')
      .on(table.versionGroupId)
      .where(sql`${table.versionShown}`),
    index('library_track_album_idx').on(table.albumMediaItemId),
    index('library_track_spotify_album_idx').on(table.spotifyAlbumId),
    index('library_track_album_name_search_idx').using(
      'gin',
      table.albumName.op('gin_trgm_ops'),
    ),
    index('library_track_added_id_idx').on(
      table.dateAdded.desc().nullsLast(),
      table.mediaItemId,
    ),
  ],
)

export const recordingBrowseOrderDirty = pgTable(
  'recording_browse_order_dirty',
  {
    transactionId: bigint('transaction_id', { mode: 'bigint' }).primaryKey(),
  },
)

export const recordingBrowseOrderState = pgTable(
  'recording_browse_order_state',
  {
    singleton: boolean('singleton').primaryKey(),
    builder: text('builder').notNull(),
    totalCount: integer('total_count'),
    maintenanceOnly: boolean('maintenance_only').default(false).notNull(),
    retryAfter: timestamp('retry_after', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
)

export const recordingBrowseOrder = pgTable(
  'recording_browse_order',
  {
    id: text('id').primaryKey(),
    versionCount: integer('version_count').notNull(),
    scrobbles: integer('scrobbles').notNull(),
    lastListenedAt: timestamp('last_listened_at', { mode: 'date' }),
    dateAdded: timestamp('date_added', { mode: 'date' }),
    ascendingRank: integer('ascending_rank').notNull(),
    descendingRank: integer('descending_rank').notNull(),
  },
  (table) => [
    uniqueIndex('recording_browse_order_ascending_idx').on(table.ascendingRank),
    uniqueIndex('recording_browse_order_descending_idx').on(
      table.descendingRank,
    ),
  ],
)

// Published with the matching recording order. Singleton ranks need no rows.
export const recordingBrowseOrderMember = pgTable(
  'recording_browse_order_member',
  {
    trackId: text('track_id').primaryKey(),
    recordingId: text('recording_id').notNull(),
  },
  (table) => [
    index('recording_browse_order_member_recording_idx').on(table.recordingId),
  ],
)

// The keys two tracks are compared on when looking for possible duplicates:
// the first artist and the title, as the scrobble matcher normalises them.
export const trackMatchKey = pgTable(
  'track_match_key',
  {
    trackId: text('track_id')
      .primaryKey()
      .references(() => libraryTrack.mediaItemId, { onDelete: 'cascade' }),
    artistKey: text('artist_key').notNull(),
    // The title without credits, remaster and edition notes.
    versionKey: text('version_key').notNull(),
    // The title with only case, accents and punctuation removed.
    plainKey: text('plain_key').notNull(),
  },
  (table) => [
    index('track_match_key_artist_version_idx').on(
      table.artistKey,
      table.versionKey,
    ),
  ],
)

// Tracks that look like the same track twice, published by the duplicates
// refresh. A group the owner kept separate is not published.
export const trackDuplicateGroup = pgTable(
  'track_duplicate_group',
  {
    id: text('id').primaryKey(),
    rule: text('rule').notNull(),
    evidence: jsonb('evidence').$type<JsonValue>().notNull(),
    cautions: jsonb('cautions').$type<JsonValue>().notNull(),
    memberCount: integer('member_count').notNull(),
    scrobbles: integer('scrobbles').default(0).notNull(),
    // Most scrobbles first.
    rank: integer('rank').notNull(),
  },
  (table) => [index('track_duplicate_group_rank_idx').on(table.rank)],
)

export const trackDuplicateMember = pgTable(
  'track_duplicate_member',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => trackDuplicateGroup.id, { onDelete: 'cascade' }),
    trackId: text('track_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.trackId] }),
    uniqueIndex('track_duplicate_member_track_uidx').on(table.trackId),
  ],
)

export const trackDuplicateDirty = pgTable('track_duplicate_dirty', {
  transactionId: bigint('transaction_id', { mode: 'bigint' }).primaryKey(),
})

export const trackDuplicateState = pgTable('track_duplicate_state', {
  singleton: boolean('singleton').primaryKey(),
  builder: text('builder').notNull(),
  groupCount: integer('group_count'),
  maintenanceOnly: boolean('maintenance_only').default(false).notNull(),
  retryAfter: timestamp('retry_after', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const trackFacetDirty = pgTable('track_facet_dirty', {
  transactionId: bigint('transaction_id', { mode: 'bigint' }).primaryKey(),
})

export const trackFacetState = pgTable('track_facet_state', {
  singleton: boolean('singleton').primaryKey(),
  builder: text('builder').notNull(),
  ready: boolean('ready').default(false).notNull(),
  maintenanceOnly: boolean('maintenance_only').default(false).notNull(),
  retryAfter: timestamp('retry_after', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const trackFacetValue = pgTable(
  'track_facet_value',
  {
    field: text('field').notNull(),
    rank: bigint('rank', { mode: 'bigint' }).notNull(),
    value: text('value').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.field, table.rank] })],
)

export const artist = pgTable(
  'artist',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortName: text('sort_name'),
    // Scrobbles linked to the artist's library albums and tracks, counted
    // once. Recomputed whenever scrobble links are.
    scrobbleCount: integer('scrobble_count').default(0).notNull(),
    // The artist this name was merged into. The row stays as a name that
    // artist keeps, and every import credits the artist it points at.
    mergedIntoId: text('merged_into_id').references(
      (): AnyPgColumn => artist.id,
      { onDelete: 'set null' },
    ),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('artist_name_uidx').on(table.name),
    index('artist_merged_into_idx').on(table.mergedIntoId),
    index('artist_name_search_idx').using('gin', table.name.op('gin_trgm_ops')),
    index('artist_browse_name_idx').on(
      sql`lower(coalesce(${table.sortName}, ${table.name}))`,
      table.id,
    ),
    index('artist_browse_scrobbles_idx').on(
      table.scrobbleCount.desc().nullsLast(),
      table.id,
    ),
  ],
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
    // The name the source gave, when the credit went to the artist that name
    // was merged into. Null when it is the artist's own name.
    creditedAs: text('credited_as'),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaItemId, table.artistId, table.role],
    }),
    index('media_credit_artist_role_media_idx').on(
      table.artistId,
      table.role,
      table.mediaItemId,
    ),
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
    index('tag_name_search_idx').using('gin', table.name.op('gin_trgm_ops')),
    index('tag_normalized_name_search_idx').using(
      'gin',
      sql`(${normalizedTagSql(sql`${table.name}`).inlineParams()}) gin_trgm_ops`,
    ),
    uniqueIndex('tag_media_type_name_kind_uidx').on(
      table.mediaType,
      table.name,
      table.kind,
    ),
    // Hierarchy keys and filters look tags up by their normalized name.
    index('tag_media_type_name_key_idx').on(
      table.mediaType,
      sql`(${normalizedTagSql(sql`${table.name}`).inlineParams()})`,
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
    index('tag_identity_name_search_idx').using(
      'gin',
      table.normalizedName.op('gin_trgm_ops'),
    ),
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
    index('tag_occurrence_raw_name_search_idx').using(
      'gin',
      table.rawName.op('gin_trgm_ops'),
    ),
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

// A tag group is every tag row of one library sharing a normalized name, so
// hierarchy edges are keyed by that name, not by one row's id.
export const tagParent = pgTable(
  'tag_parent',
  {
    mediaType: mediaTypeEnum('media_type').notNull(),
    childKey: text('child_key').notNull(),
    parentKey: text('parent_key').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaType, table.childKey, table.parentKey],
    }),
    index('tag_parent_parent_idx').on(table.mediaType, table.parentKey),
    check('tag_parent_not_self', sql`${table.childKey} <> ${table.parentKey}`),
  ],
)

// Every ancestor of every tag group, rebuilt from tag_parent on each change so
// filters and facet counts read parents with one join.
export const tagAncestor = pgTable(
  'tag_ancestor',
  {
    mediaType: mediaTypeEnum('media_type').notNull(),
    descendantKey: text('descendant_key').notNull(),
    ancestorKey: text('ancestor_key').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaType, table.descendantKey, table.ancestorKey],
    }),
    index('tag_ancestor_ancestor_idx').on(table.mediaType, table.ancestorKey),
  ],
)

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
    presentationOverride: text('presentation_override', {
      enum: ['albums', 'tracks'],
    }),
    // Spotify's version of the playlist contents at the last import.
    snapshotId: text('snapshot_id'),
    // When the contents were last read and stored.
    importedAt: timestamp('imported_at'),
    // When an import last completed, including one that found no change.
    checkedAt: timestamp('checked_at'),
    // off, 1h, 3h, 6h, daily or weekly, measured from checked_at.
    syncSchedule: text('sync_schedule').notNull().default('off'),
    // The owner who set the schedule; scheduled imports use their account.
    syncUserId: text('sync_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    // Whether the account owns or collaborates on the Spotify playlist, as
    // last seen by a listing, import or album addition.
    spotifyEditable: boolean('spotify_editable').notNull().default(true),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('playlist_name_kind_uidx').on(table.name, table.kind),
    uniqueIndex('playlist_spotify_id_uidx').on(table.spotifyId),
    index('playlist_name_search_idx').using(
      'gin',
      table.name.op('gin_trgm_ops'),
    ),
    check(
      'playlist_presentation_override_check',
      sql`${table.presentationOverride} in ('albums', 'tracks')`,
    ),
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

// The connected account's playlist list as the last listing job read it.
export const spotifyPlaylistListing = pgTable('spotify_playlist_listing', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // The listed playlists in Spotify's order; validated when read.
  playlists: jsonb('playlists').$type<JsonValue[]>().notNull(),
  listedAt: timestamp('listed_at').notNull(),
  ...timestampColumns,
})

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

export const artistSelectionSnapshot = pgTable(
  'artist_selection_snapshot',
  {
    id: text('id').primaryKey(),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    totalCount: integer('total_count').notNull().default(0),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('artist_selection_snapshot_expiry_idx').on(table.expiresAt),
  ],
)

export const artistSelectionMember = pgTable(
  'artist_selection_member',
  {
    selectionId: text('selection_id')
      .notNull()
      .references(() => artistSelectionSnapshot.id, { onDelete: 'cascade' }),
    // Retain the reviewed set if an artist is removed before dispatch.
    artistId: text('artist_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.selectionId, table.artistId] })],
)

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
    index('scrape_job_created_id_idx').on(
      table.createdAt.desc().nullsLast(),
      table.id.desc(),
    ),
    index('scrape_job_batch_idx').on(sql`(${table.options}->>'batchId')`),
    index('scrape_job_spotify_track_search_idx')
      .on(
        sql`(${table.options}->>'trackId')`,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.options}->>'task' = 'spotify-track-search'`),
    index('scrape_job_spotify_track_search_retained_idx')
      .on(
        sql`(coalesce(${table.options}->>'acceptedTrackId', ${table.options}->>'trackId'))`,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.options}->>'task' = 'spotify-track-search'`),
    index('scrape_job_tidal_track_match_idx')
      .on(
        sql`(${table.options}->>'trackId')`,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(
        sql`${table.provider} = 'tidal' and ${table.options}->>'task' = 'tidal-track-match'`,
      ),
    index('scrape_job_similar_item_idx')
      .on(
        sql`(${table.options}->>'task')`,
        sql`(${table.options}->>'itemId')`,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(
        sql`${table.options}->>'task' in ('tidal-similar', 'spotify-similar-lookup', 'sonovault-similar-lookup')`,
      ),
    index('scrape_job_artist_created_idx')
      .on(
        table.provider,
        sql`(${table.options}->>'artistId')`,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.options}->>'task' = 'artist-enrichment'`),
    index('scrape_job_artist_attempt_idx')
      .on(
        table.provider,
        sql`(${table.options}->>'artistId')`,
        table.startedAt.desc(),
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(
        sql`${table.options}->>'task' = 'artist-enrichment' and ${table.startedAt} is not null and ${table.status} <> 'queued'`,
      ),
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

export const providerResponse = pgTable(
  'provider_response',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => scrapeJob.id, { onDelete: 'cascade' }),
    jobItemId: text('job_item_id').references(() => scrapeJobItem.id, {
      onDelete: 'cascade',
    }),
    artistId: text('artist_id').references(() => artist.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    attempt: integer('attempt').notNull(),
    ordinal: integer('ordinal').notNull(),
    phase: text('phase', { enum: ['media', 'artist', 'task'] }).notNull(),
    method: text('method').notNull(),
    requestUrl: text('request_url'),
    requestKey: text('request_key'),
    status: integer('status'),
    receivedAt: timestamp('received_at'),
    contentType: text('content_type'),
    retry: integer('retry'),
    notFound: boolean('not_found').default(false).notNull(),
    bodyState: text('body_state', {
      enum: ['captured', 'local', 'unavailable'],
    }).notNull(),
    retainedBytes: integer('retained_bytes').notNull(),
    body: jsonb('body').$type<ProviderResponseBody>().notNull(),
  },
  (table) => [
    index('provider_response_job_order_idx').on(
      table.jobId,
      table.attempt,
      table.ordinal,
      table.id,
    ),
    uniqueIndex('provider_response_item_attempt_uidx')
      .on(table.jobId, table.jobItemId, table.attempt, table.ordinal)
      .where(sql`${table.jobItemId} is not null`),
    uniqueIndex('provider_response_task_attempt_uidx')
      .on(table.jobId, table.attempt, table.ordinal)
      .where(sql`${table.jobItemId} is null`),
    check(
      'provider_response_sequence_check',
      sql`${table.attempt} > 0 and ${table.ordinal} > 0`,
    ),
    check(
      'provider_response_body_state_check',
      sql`${table.bodyState} = ${table.body}->>'state'`,
    ),
    check(
      'provider_response_size_check',
      sql`${table.retainedBytes} between 0 and 16777216`,
    ),
  ],
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

/**
 * The similar albums or tracks TIDAL last returned for one library album or
 * track, in TIDAL's order. The raw response is the job's stored response.
 */
export const tidalSimilar = pgTable('tidal_similar', {
  mediaItemId: text('media_item_id')
    .primaryKey()
    .references(() => mediaItem.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  items: jsonb('items').$type<JsonValue>().notNull(),
  scrapeJobId: text('scrape_job_id').references(() => scrapeJob.id, {
    onDelete: 'set null',
  }),
  readAt: timestamp('read_at', { mode: 'date', withTimezone: false }).notNull(),
  ...timestampColumns,
})

/**
 * The latest Sonovault lookup of one library track: what was sent, whether it
 * matched, and the primary ISRC it gave the track (SONO-07, still Sonovault's
 * while it equals `library_track.isrc`). A miss is not repeated for 30 days.
 */
export const sonovaultTrackLookup = pgTable(
  'sonovault_track_lookup',
  {
    mediaItemId: text('media_item_id')
      .primaryKey()
      .references(() => mediaItem.id, { onDelete: 'cascade' }),
    inputType: text('input_type').notNull(),
    input: text('input').notNull(),
    status: text('status').notNull(),
    sonovaultTrackId: text('sonovault_track_id'),
    verified: boolean('verified'),
    primaryIsrc: text('primary_isrc'),
    scrapeJobId: text('scrape_job_id').references(() => scrapeJob.id, {
      onDelete: 'set null',
    }),
    responseId: text('response_id').references(() => providerResponse.id, {
      onDelete: 'set null',
    }),
    lookedUpAt: timestamp('looked_up_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    ...timestampColumns,
  },
  (table) => [
    index('sonovault_track_lookup_looked_up_idx').on(
      table.status,
      table.lookedUpAt,
    ),
  ],
)

/**
 * Tempo and key a provider reported for a library track, one row per track
 * and provider. Unverified rows may describe another version of the
 * recording: they are shown only in track details.
 */
export const trackFact = pgTable(
  'track_fact',
  {
    mediaItemId: text('media_item_id')
      .notNull()
      .references(() => libraryTrack.mediaItemId, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    bpm: doublePrecision('bpm'),
    keyCamelot: text('key_camelot'),
    keyMusical: text('key_musical'),
    keyOpen: text('key_open'),
    // The tool the provider names as having measured the key.
    keySource: text('key_source'),
    verified: boolean('verified').notNull(),
    responseId: text('response_id').references(() => providerResponse.id, {
      onDelete: 'set null',
    }),
    fetchedAt: timestamp('fetched_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.mediaItemId, table.provider] }),
    index('track_fact_verified_bpm_idx')
      .on(table.provider, table.bpm)
      .where(sql`${table.verified} and ${table.bpm} is not null`),
    index('track_fact_verified_key_idx')
      .on(table.provider, table.keyCamelot)
      .where(sql`${table.verified} and ${table.keyCamelot} is not null`),
    // Deleting a job's responses clears their IDs here.
    index('track_fact_response_idx')
      .on(table.responseId)
      .where(sql`${table.responseId} is not null`),
    check(
      'track_fact_bpm_range',
      sql`${table.bpm} is null or (${table.bpm} > 0 and ${table.bpm} <= 1000)`,
    ),
    check(
      'track_fact_key_camelot',
      sql`${table.keyCamelot} is null or ${table.keyCamelot} ~ '^(1[0-2]|[1-9])[AB]$'`,
    ),
  ],
)

/**
 * What a Spotify `isrc:` or `upc:` search found for one code, or a miss.
 * UPCs are stored without leading zeros.
 */
export const spotifyCodeLookup = pgTable(
  'spotify_code_lookup',
  {
    codeType: text('code_type').notNull(),
    code: text('code').notNull(),
    spotifyId: text('spotify_id'),
    result: jsonb('result').$type<Record<string, JsonValue>>(),
    /**
     * Who answered: a Spotify search, or Sonovault's bulk resolve (SONO-26),
     * whose rows follow its terms and are removed with its data.
     */
    source: text('source')
      .$type<SpotifyCodeLookupSource>()
      .notNull()
      .default('spotify'),
    /** The stored Sonovault response a `sonovault` row was read from. */
    responseId: text('response_id'),
    scrapeJobId: text('scrape_job_id').references(() => scrapeJob.id, {
      onDelete: 'set null',
    }),
    searchedAt: timestamp('searched_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    ...timestampColumns,
  },
  (table) => [primaryKey({ columns: [table.codeType, table.code] })],
)

export const artistProviderSnapshot = pgTable(
  'artist_provider_snapshot',
  {
    id: text('id').primaryKey(),
    artistId: text('artist_id')
      .notNull()
      .references(() => artist.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ArtistProviderId>().notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    normalizedData: jsonb('normalized_data').$type<ArtistProfile>().notNull(),
    scrapeJobId: text('scrape_job_id').references(() => scrapeJob.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('artist_provider_snapshot_tag_keys_idx').using(
      'gin',
      sql`artist_profile_tag_keys(${table.normalizedData}->'tags')`,
    ),
    index('artist_provider_snapshot_artist_time_idx').on(
      table.artistId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
)

export const artistProviderCurrentState = pgTable(
  'artist_provider_current_state',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artist.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ArtistProviderId>().notNull(),
    latestSnapshotId: text('latest_snapshot_id')
      .notNull()
      .references(() => artistProviderSnapshot.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.artistId, table.provider] })],
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
    index('lastfm_scrobble_track_time_user_idx').on(
      table.trackKey,
      table.artistKey,
      table.listenedAt,
      table.username,
    ),
    index('lastfm_scrobble_time_album_idx')
      .on(table.listenedAt, table.albumMediaItemId)
      .where(sql`${table.albumMediaItemId} is not null`),
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

// Library membership is stricter than listening attribution: one scrobbled
// name has one library identity, even when several Spotify editions match.
export const lastfmTrackSource = pgTable(
  'lastfm_track_source',
  {
    username: text('username').notNull(),
    artistKey: text('artist_key').notNull(),
    trackKey: text('track_key').notNull(),
    // Explicit identity choices survive automatic Last.fm refreshes.
    manuallyMatched: boolean('manually_matched').notNull().default(false),
    trackMediaItemId: text('track_media_item_id')
      .notNull()
      .references(() => libraryTrack.mediaItemId, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.username, table.artistKey, table.trackKey] }),
    index('lastfm_track_source_track_idx').on(table.trackMediaItemId),
  ],
)

/** A record as it was named when a library change was made. */
export type LibraryChangeRecordSnapshot = {
  id: string
  title: string
  by: string
}

// One run that made automatic changes: a Last.fm sync, an album refresh, a
// playlist import. History lists a run as one row.
export const libraryChangeBatch = pgTable(
  'library_change_batch',
  {
    id: text('id').primaryKey(),
    // lastfm-sync, relink, album-refresh, playlist-import, spotify-search or
    // backfill.
    trigger: text('trigger').notNull(),
    changeCount: integer('change_count').default(0).notNull(),
    nameCount: integer('name_count').default(0).notNull(),
    scrobbles: integer('scrobbles').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('library_change_batch_created_idx').on(table.createdAt)],
)

// Every merge, move and separation, by the owner or by an automatic rule. A
// change keeps its moves, its other effects and the tracks it removed, so it
// can be undone and made again.
export const libraryChange = pgTable(
  'library_change',
  {
    id: text('id').primaryKey(),
    // track, album or artist.
    kind: text('kind').notNull(),
    // merge, move, separate, rematch, show or keep-separate.
    action: text('action').notNull(),
    // owner or automatic.
    actor: text('actor').notNull(),
    rule: text('rule'),
    batchId: text('batch_id').references(() => libraryChangeBatch.id, {
      onDelete: 'set null',
    }),
    target: jsonb('target').$type<LibraryChangeRecordSnapshot>(),
    sources: jsonb('sources')
      .$type<LibraryChangeRecordSnapshot[]>()
      .notNull()
      .default([]),
    scrobbles: integer('scrobbles').notNull().default(0),
    // What the change moved besides scrobbled track names, for History.
    details: jsonb('details').$type<LibraryChangeDetails>(),
    // False for a change made before its other effects were recorded.
    reversible: boolean('reversible').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    undoneAt: timestamp('undone_at'),
  },
  (table) => [
    index('library_change_kind_created_idx').on(table.kind, table.createdAt),
    index('library_change_kind_actor_created_idx').on(
      table.kind,
      table.actor,
      table.createdAt,
      table.id,
    ),
    index('library_change_batch_idx').on(table.batchId, table.createdAt),
  ],
)

// Something a change did besides moving scrobbled track names: joining
// versions, moving an album position, a playlist entry, an album name or a
// credit, or storing a decision. `type` names the handler that can undo and
// redo it from `payload`.
export const libraryChangeEffect = pgTable(
  'library_change_effect',
  {
    changeId: text('change_id')
      .notNull()
      .references(() => libraryChange.id, { onDelete: 'cascade' }),
    // The order the change made its effects in. Undo runs them backwards.
    position: integer('position').notNull(),
    type: text('type').notNull(),
    // The records the effect touched, for the changes of one record.
    recordIds: text('record_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.changeId, table.position] }),
    index('library_change_effect_records_idx').using('gin', table.recordIds),
  ],
)

// Two records the owner said are different. They are not suggested as
// duplicates and no automatic rule merges them. Removed when the change that
// stored the decision is undone.
export const libraryKeepSeparate = pgTable(
  'library_keep_separate',
  {
    // track, album or artist.
    kind: text('kind').notNull(),
    lowId: text('low_id').notNull(),
    highId: text('high_id').notNull(),
    changeId: text('change_id').references(() => libraryChange.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.lowId, table.highId] }),
    index('library_keep_separate_high_idx').on(table.kind, table.highId),
  ],
)

// A match of a scrobbled name to a track that was undone or separated. No
// automatic rule makes it again. Removed when the change is made again or the
// name is returned to automatic matching.
export const libraryMatchRejection = pgTable(
  'library_match_rejection',
  {
    username: text('username').notNull(),
    artistKey: text('artist_key').notNull(),
    trackKey: text('track_key').notNull(),
    recordId: text('record_id').notNull(),
    rule: text('rule'),
    // undo or separate.
    reason: text('reason').notNull(),
    changeId: text('change_id').references(() => libraryChange.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.username,
        table.artistKey,
        table.trackKey,
        table.recordId,
      ],
    }),
    index('library_match_rejection_change_idx').on(table.changeId),
    index('library_match_rejection_record_idx').on(table.recordId),
  ],
)

// One scrobbled name a change moved, with its owner and manual flag on both
// sides. A removed track keeps its ID here and is restored from
// `library_change_removal`.
export const libraryChangeMove = pgTable(
  'library_change_move',
  {
    changeId: text('change_id')
      .notNull()
      .references(() => libraryChange.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    artistKey: text('artist_key').notNull(),
    trackKey: text('track_key').notNull(),
    // The names as scrobbled, for the list of changes.
    artistName: text('artist_name').notNull(),
    trackName: text('track_name').notNull(),
    scrobbles: integer('scrobbles').notNull().default(0),
    fromId: text('from_id').notNull(),
    fromManual: boolean('from_manual').notNull(),
    toId: text('to_id').notNull(),
    toManual: boolean('to_manual').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.changeId,
        table.username,
        table.artistKey,
        table.trackKey,
      ],
    }),
    index('library_change_move_from_idx').on(table.fromId),
    index('library_change_move_to_idx').on(table.toId),
  ],
)

// A Last.fm-only track that a change left without names and removed. The
// snapshot holds its media item, library track, artist credits and tag IDs.
export const libraryChangeRemoval = pgTable(
  'library_change_removal',
  {
    changeId: text('change_id')
      .notNull()
      .references(() => libraryChange.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, JsonValue>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.changeId, table.recordId] })],
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

// Tracks the player played on Sonos rooms, kept to scrobble them to the
// user's Last.fm account. Rows only de-duplicate reports and hold plays until
// Last.fm takes them; they are deleted once Last.fm would refuse them as too
// old. The history sync reads the scrobbles back into lastfm_scrobble.
export const lastfmPlay = pgTable(
  'lastfm_play',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    trackUri: text('track_uri').notNull(),
    artist: text('artist').notNull(),
    track: text('track').notNull(),
    // Empty when the album is not known.
    album: text('album').notNull().default(''),
    durationMs: integer('duration_ms'),
    // UTC, when the track began.
    startedAt: timestamp('started_at').notNull(),
    // waiting, sent, or ignored.
    status: text('status').notNull().default('waiting'),
    // Last.fm's ignoredMessage code; null for a play dropped here as too old.
    ignoredCode: integer('ignored_code'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    sentAt: timestamp('sent_at'),
  },
  (table) => [
    index('lastfm_play_user_track_time_idx').on(
      table.userId,
      table.trackUri,
      table.startedAt,
    ),
    index('lastfm_play_waiting_idx')
      .on(table.userId, table.startedAt)
      .where(sql`${table.status} = 'waiting'`),
    check(
      'lastfm_play_status_check',
      sql`${table.status} in ('waiting', 'sent', 'ignored')`,
    ),
  ],
)

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// Channels and podcasts one account follows: YouTube channels and Spotify
// shows, keyed by the provider's own ID. The type is fixed by the provider.
export const subscriptionSource = pgTable(
  'subscription_source',
  {
    id: text('id').primaryKey(),
    // youtube or spotify (Subscriptions), or a station: rinse, nts, lotradio (Mixes).
    type: text('type').notNull(),
    title: text('title').notNull(),
    // A YouTube handle, or a station show's slug on the station's site.
    handle: text('handle'),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    // A station show's page; YouTube and Spotify addresses derive from the ID.
    url: text('url'),
    uploadsPlaylistId: text('uploads_playlist_id'),
    subscriberCount: bigint('subscriber_count', { mode: 'number' }),
    // The provider's total when the source was last listed: Spotify's episode
    // total or YouTube's public video count.
    itemTotal: integer('item_total'),
    // YouTube only: the listed total when the channel's uploads were last read.
    readItemTotal: integer('read_item_total'),
    // Cleared when a sync no longer lists the subscription; items are kept.
    subscribed: boolean('subscribed').notNull().default(true),
    // The sync run that last listed the subscription.
    seenRunId: text('seen_run_id'),
    // Every page of the source's items has been read at least once.
    historyComplete: boolean('history_complete').notNull().default(false),
    // The sync run that last recorded a YouTube channel's Shorts.
    shortsRunId: text('shorts_run_id'),
    ...timestampColumns,
  },
  (table) => [
    index('subscription_source_title_search_idx').using(
      'gin',
      table.title.op('gin_trgm_ops'),
    ),
    index('subscription_source_exact_title_idx')
      .on(sql`lower(btrim(${table.title}))`)
      .where(sql`${table.subscribed}`),
    index('subscription_source_type_subscribed_idx').on(
      table.type,
      table.subscribed,
      table.id,
    ),
    check(
      'subscription_source_type_check',
      sql`${table.type} in ('youtube', 'spotify', 'rinse', 'nts', 'lotradio')`,
    ),
  ],
)

// YouTube videos, Spotify episodes and station mixes; the type matches the source's.
export const subscriptionItem = pgTable(
  'subscription_item',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => subscriptionSource.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    // Station mixes: the billed performers as the station names them.
    artists: jsonb('artists').$type<string[]>().notNull().default([]),
    // Station mixes: the episode's page, and its recording (a file, a stream
    // or its SoundCloud or Mixcloud page) when the station gives one.
    url: text('url'),
    audioUrl: text('audio_url'),
    // UTC, as reported by the provider.
    publishedAt: timestamp('published_at', {
      mode: 'date',
      withTimezone: false,
    }).notNull(),
    // time, day, month or year: how much of publishedAt the provider reported.
    publishedPrecision: text('published_precision').notNull().default('time'),
    durationSec: integer('duration_sec').notNull().default(0),
    viewCount: bigint('view_count', { mode: 'number' }),
    likeCount: bigint('like_count', { mode: 'number' }),
    commentCount: bigint('comment_count', { mode: 'number' }),
    // none, live or upcoming.
    live: text('live').notNull().default('none'),
    // Spotify episode artwork; YouTube thumbnails derive from the video ID.
    artworkUrl: text('artwork_url'),
    // UTC. Set by the owner, never by a sync; null when not watched.
    watchedAt: timestamp('watched_at', { mode: 'date', withTimezone: false }),
    // Title (A), source title, tags and artists (B), description (D).
    search: tsvector('search').notNull(),
    ...timestampColumns,
  },
  (table) => [
    index('subscription_item_search_idx').using('gin', table.search),
    index('subscription_item_artist_name_keys_idx').using(
      'gin',
      sql`subscription_artist_name_keys(${table.artists})`,
    ),
    index('subscription_item_title_search_idx').using(
      'gin',
      table.title.op('gin_trgm_ops'),
    ),
    index('subscription_item_source_published_idx').on(
      table.sourceId,
      table.publishedAt,
    ),
    index('subscription_item_published_idx').on(table.publishedAt, table.id),
    index('subscription_item_views_idx').on(table.viewCount),
    index('subscription_item_duration_value_idx').on(
      sql`nullif(${table.durationSec}, 0)`,
    ),
  ],
)

// YouTube Shorts by video ID, recorded so that no sync stores them as items.
export const subscriptionShort = pgTable('subscription_short', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => subscriptionSource.id, { onDelete: 'cascade' }),
  // The sync run that first recorded the Short.
  runId: text('run_id'),
})

// One checkpoint per account and provider.
export const subscriptionSync = pgTable(
  'subscription_sync',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // youtube, spotify or a station.
    provider: text('provider').notNull(),
    // Stations: a full read of the archive has completed, so later runs read
    // only the station's recent additions.
    historyComplete: boolean('history_complete').notNull().default(false),
    // Stations: a feed page of this run ended before reaching the last
    // completed run, so the run leaves the archive to be read in full again.
    feedTruncated: boolean('feed_truncated').notNull().default(false),
    // running, paused, failed, complete, or idle before the first run.
    status: text('status').notNull(),
    schedule: text('schedule').notNull().default('daily'),
    runId: text('run_id'),
    // sources, then items.
    phase: text('phase').notNull().default('sources'),
    // Next page of the source list, or of the current source's items.
    pageToken: text('page_token'),
    // Next page of the current YouTube channel's Shorts, read before its items.
    shortsPageToken: text('shorts_page_token'),
    // The last source whose items were read in this run.
    sourceCursor: text('source_cursor'),
    sourcesDone: integer('sources_done').notNull().default(0),
    sourcesTotal: integer('sources_total').notNull().default(0),
    newItems: integer('new_items').notNull().default(0),
    // When a run paused by the daily quota may continue.
    resumeAfter: timestamp('resume_after'),
    errorMessage: text('error_message'),
    leaseToken: text('lease_token'),
    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at'),
    ...timestampColumns,
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
)

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
  libraryTrack: one(libraryTrack, {
    fields: [track.trackMediaItemId],
    references: [libraryTrack.mediaItemId],
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

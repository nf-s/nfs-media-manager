/**
 * The SQLite schema of the device store (DEVICE-21). Plain SQLite: FTS5 with
 * the trigram tokenizer and the JSON functions, nothing host-specific.
 *
 * Conventions:
 * - Each item table (`track`, `album`, `film`, `artist`, `playlist`) has an
 *   integer `rid` and the feed `id`. Derived tables refer to an item by
 *   `(entity, rid)`, which keeps them and their indexes small.
 * - The list item a page returns is in `item_json`, apart from the item
 *   tables, so scans for filters, sorts and counts read narrow rows.
 * - Text is compared by code point (`BINARY`). `folded` columns hold
 *   `foldText(value)`; a query value is folded the same way before binding.
 * - The FTS tables use `detail = none`: search with
 *   `folded GLOB globContains(word)`, which the trigram index serves for
 *   three or more characters and rechecks against the value; MATCH phrase
 *   queries are not available.
 * - Booleans are 0 or 1. Dates are whole epoch microseconds, play times whole
 *   epoch seconds, as the feed sends them.
 * - `item_num` and `item_sort` hold a row only for a non-null value: a
 *   missing row is a null.
 * - The item tables repeat a few values from `item_num` and `item_sort` as
 *   indexed columns, so the common sorts read one table.
 *
 * A change to any statement bumps `STORE_SCHEMA_VERSION`; a store with
 * another version is dropped and refilled, never migrated.
 */
export const STORE_SCHEMA_VERSION = 1

export const ITEM_ENTITIES = [
  'track',
  'album',
  'film',
  'artist',
  'playlist',
] as const
export type ItemEntity = (typeof ITEM_ENTITIES)[number]

const syncState = [
  `
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('empty', 'filling', 'ready')),
  epoch TEXT,
  row_version INTEGER,
  snapshot_seq INTEGER,
  fill_entity TEXT,
  fill_after INTEGER,
  cursor INTEGER,
  filled_at INTEGER,
  synced_at INTEGER
)`,
  `INSERT INTO sync_state (id, phase) VALUES (1, 'empty')`,
]

const track = [
  `
CREATE TABLE track (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  redundant_placeholder INTEGER NOT NULL,
  album_id TEXT,
  has_own_tags INTEGER NOT NULL,
  album_release_tag_count INTEGER,
  recording_key TEXT,
  recording_shown INTEGER NOT NULL,
  recording_playable INTEGER NOT NULL,
  recording_linked INTEGER NOT NULL,
  recording_release_date NUMERIC,
  natural_artist TEXT,
  natural_album_date NUMERIC,
  natural_year NUMERIC,
  natural_spotify_album_id TEXT,
  natural_position NUMERIC,
  sort_title TEXT,
  sort_artist TEXT,
  sort_album TEXT,
  sort_release_date NUMERIC,
  date_added NUMERIC,
  scrobbles NUMERIC,
  last_listened_at NUMERIC
)`,
  `CREATE INDEX track_date_added ON track (archived, date_added)`,
  `CREATE INDEX track_sort_title ON track (archived, sort_title)`,
  `CREATE INDEX track_sort_artist ON track (archived, sort_artist)`,
  `CREATE INDEX track_sort_album ON track (archived, sort_album)`,
  `CREATE INDEX track_sort_release_date ON track (archived, sort_release_date)`,
  `CREATE INDEX track_recording_key ON track (recording_key)`,
  `CREATE INDEX track_album_id ON track (album_id)`,
]

const album = [
  `
CREATE TABLE album (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  is_edition INTEGER NOT NULL,
  release_tag_count INTEGER NOT NULL,
  sort_title TEXT,
  sort_artist TEXT,
  release_date NUMERIC,
  date_added NUMERIC
)`,
  `CREATE INDEX album_date_added ON album (archived, date_added)`,
  `CREATE INDEX album_sort_title ON album (archived, sort_title)`,
  `CREATE INDEX album_sort_artist ON album (archived, sort_artist)`,
  `CREATE INDEX album_release_date ON album (archived, release_date)`,
]

const film = [
  `
CREATE TABLE film (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  source_kind TEXT,
  sort_title TEXT,
  release_date NUMERIC,
  date_added NUMERIC
)`,
  `CREATE INDEX film_date_added ON film (archived, date_added)`,
  `CREATE INDEX film_sort_title ON film (archived, sort_title)`,
  `CREATE INDEX film_release_date ON film (archived, release_date)`,
]

const artist = [
  `
CREATE TABLE artist (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  sort_name TEXT,
  created_at NUMERIC,
  scrobbles NUMERIC
)`,
  `CREATE INDEX artist_sort_name ON artist (sort_name)`,
  `CREATE INDEX artist_scrobbles ON artist (scrobbles)`,
]

const playlist = [
  `
CREATE TABLE playlist (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  sync_group_key TEXT,
  sort_name TEXT,
  added NUMERIC
)`,
  `CREATE INDEX playlist_sort_name ON playlist (sort_name)`,
  `CREATE INDEX playlist_sync_group_key ON playlist (sync_group_key)`,
]

const itemJson = [
  `
CREATE TABLE item_json (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (entity, rid)
)`,
]

const itemText = [
  `
CREATE TABLE item_text (
  tid INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  folded TEXT NOT NULL
)`,
  `CREATE INDEX item_text_item ON item_text (entity, rid)`,
  `CREATE INDEX item_text_match ON item_text (entity, field, folded, rid)`,
  `
CREATE VIRTUAL TABLE item_text_fts USING fts5 (
  folded,
  content = 'item_text',
  content_rowid = 'tid',
  tokenize = 'trigram case_sensitive 1',
  detail = none,
  columnsize = 0
)`,
  `
CREATE TRIGGER item_text_fts_insert AFTER INSERT ON item_text BEGIN
  INSERT INTO item_text_fts (rowid, folded) VALUES (new.tid, new.folded);
END`,
  `
CREATE TRIGGER item_text_fts_delete AFTER DELETE ON item_text BEGIN
  INSERT INTO item_text_fts (item_text_fts, rowid, folded)
  VALUES ('delete', old.tid, old.folded);
END`,
]

const itemSearch = [
  `
CREATE TABLE item_search (
  sid INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  field TEXT NOT NULL,
  folded TEXT NOT NULL
)`,
  `CREATE INDEX item_search_item ON item_search (entity, rid)`,
  `
CREATE VIRTUAL TABLE item_search_fts USING fts5 (
  folded,
  content = 'item_search',
  content_rowid = 'sid',
  tokenize = 'trigram case_sensitive 1',
  detail = none,
  columnsize = 0
)`,
  `
CREATE TRIGGER item_search_fts_insert AFTER INSERT ON item_search BEGIN
  INSERT INTO item_search_fts (rowid, folded) VALUES (new.sid, new.folded);
END`,
  `
CREATE TRIGGER item_search_fts_delete AFTER DELETE ON item_search BEGIN
  INSERT INTO item_search_fts (item_search_fts, rowid, folded)
  VALUES ('delete', old.sid, old.folded);
END`,
]

const itemValues = [
  `
CREATE TABLE item_num (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  field TEXT NOT NULL,
  value NUMERIC NOT NULL,
  PRIMARY KEY (entity, rid, field)
) WITHOUT ROWID`,
  `CREATE INDEX item_num_range ON item_num (entity, field, value)`,
  `
CREATE TABLE item_sort (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  field TEXT NOT NULL,
  value NOT NULL,
  PRIMARY KEY (entity, rid, field)
) WITHOUT ROWID`,
  `
CREATE TABLE item_tag (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  level TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (entity, rid, level, tag_id)
) WITHOUT ROWID`,
  `CREATE INDEX item_tag_tag ON item_tag (tag_id, entity, level)`,
  `
CREATE TABLE item_artist_tag_key (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'label')),
  key TEXT NOT NULL,
  PRIMARY KEY (entity, rid, kind, key)
) WITHOUT ROWID`,
  `CREATE INDEX item_artist_tag_key_key ON item_artist_tag_key (key, entity, kind)`,
  `
CREATE TABLE item_credit (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  artist_id TEXT NOT NULL,
  PRIMARY KEY (entity, rid, role, position)
) WITHOUT ROWID`,
  `CREATE INDEX item_credit_artist ON item_credit (artist_id, entity, role)`,
  `
CREATE TABLE item_playlist (
  entity TEXT NOT NULL,
  rid INTEGER NOT NULL,
  playlist_id TEXT NOT NULL,
  PRIMARY KEY (entity, rid, playlist_id)
) WITHOUT ROWID`,
  `CREATE INDEX item_playlist_playlist ON item_playlist (playlist_id, entity)`,
  `
CREATE TABLE track_name (
  rid INTEGER NOT NULL,
  name_id TEXT NOT NULL,
  PRIMARY KEY (rid, name_id)
) WITHOUT ROWID`,
  `CREATE INDEX track_name_name ON track_name (name_id)`,
]

const tags = [
  `
CREATE TABLE tag (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  alias_target_id TEXT,
  sonovault INTEGER NOT NULL
) WITHOUT ROWID`,
  `CREATE INDEX tag_key_index ON tag (media_type, key)`,
  `CREATE INDEX tag_alias_target ON tag (alias_target_id)`,
  `
CREATE TABLE tag_identity (
  tag_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (tag_id, key)
) WITHOUT ROWID`,
  `CREATE INDEX tag_identity_key ON tag_identity (key)`,
  `
CREATE TABLE tag_key (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  key TEXT NOT NULL,
  UNIQUE (media_type, key)
) WITHOUT ROWID`,
  `
CREATE TABLE tag_ancestor (
  media_type TEXT NOT NULL,
  key TEXT NOT NULL,
  ancestor_key TEXT NOT NULL,
  PRIMARY KEY (media_type, key, ancestor_key)
) WITHOUT ROWID`,
  `CREATE INDEX tag_ancestor_ancestor ON tag_ancestor (media_type, ancestor_key)`,
]

const plays = [
  `
CREATE TABLE play_set (
  pid INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('scrobble_name', 'album_plays', 'artist_plays')),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  play_count INTEGER NOT NULL,
  UNIQUE (entity, id)
)`,
  `
CREATE TABLE name_play (
  pid INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (pid, played_at, n)
) WITHOUT ROWID`,
  `
CREATE TABLE album_play (
  pid INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (pid, played_at, n)
) WITHOUT ROWID`,
  `
CREATE TABLE artist_play (
  pid INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (pid, played_at, n)
) WITHOUT ROWID`,
]

const shared = [
  `
CREATE TABLE playlist_job (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  job TEXT NOT NULL
) WITHOUT ROWID`,
  `
CREATE TABLE meta (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID`,
]

/** Every statement of the schema, one per entry, in order. */
export const STORE_SCHEMA: readonly string[] = [
  ...syncState,
  ...track,
  ...album,
  ...film,
  ...artist,
  ...playlist,
  ...itemJson,
  ...itemText,
  ...itemSearch,
  ...itemValues,
  ...tags,
  ...plays,
  ...shared,
]

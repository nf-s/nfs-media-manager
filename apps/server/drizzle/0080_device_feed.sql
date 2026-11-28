CREATE SEQUENCE "public"."device_row_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "device_dirty" (
	"key" bigserial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_feed_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" text NOT NULL,
	"row_version" integer NOT NULL,
	"min_seq" bigint DEFAULT 0 NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"sweep_entity" text,
	"sweep_after" text,
	"swept_at" timestamp with time zone,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_feed_state_singleton" CHECK ("device_feed_state"."singleton")
);
--> statement-breakpoint
CREATE TABLE "device_row" (
	"entity" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb,
	"hash" text,
	"seq" bigint NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"rendered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_row_entity_id_pk" PRIMARY KEY("entity","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_row_seq_uidx" ON "device_row" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "device_row_live_entity_seq_idx" ON "device_row" USING btree ("entity","seq") WHERE not "device_row"."deleted";--> statement-breakpoint
CREATE INDEX "device_row_tombstone_rendered_idx" ON "device_row" USING btree ("rendered_at") WHERE "device_row"."deleted";--> statement-breakpoint
-- The published members of a recording group, found from the stored row of a
-- marked track, so the members of its old group are rendered with it.
CREATE INDEX "device_row_track_recording_key_idx" ON "device_row" USING btree (("payload"->'extra'->'recording'->>'key')) WHERE "device_row"."entity" = 'track' and ("device_row"."payload"->'extra'->'recording'->>'key') is not null;--> statement-breakpoint
-- Row version 0 is older than any build, so the first maintenance run starts
-- the feed with a new epoch and sweeps it.
INSERT INTO "device_feed_state" ("epoch", "row_version") VALUES (gen_random_uuid()::text, 0);--> statement-breakpoint
-- The ID of a `scrobble_name` row. The triggers and the renderer both use it,
-- so a mark names the row the renderer publishes. Lengths keep it unambiguous.
CREATE FUNCTION device_scrobble_name_id(username text, artist_key text, track_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT md5(length(username) || ':' || username || length(artist_key) || ':' || artist_key || track_key)
$$;--> statement-breakpoint
-- The index and the triggers lock existing tables: fail rather than queue
-- behind a long write while blocking the writes behind this migration.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- The sweep lists scrobbled names in the order of their ID.
CREATE INDEX "lastfm_track_link_device_name_idx" ON "lastfm_track_link" USING btree (device_scrobble_name_id("username", "artist_key", "track_key"));--> statement-breakpoint
-- DEVICE-03: each statement on a contributing table appends one mark per
-- distinct (entity, id) whose row it may change. Over-marking is safe: the
-- render keeps a row whose hash is unchanged. The sweep corrects anything
-- missed, including TRUNCATE, which has no trigger.
--
-- Arguments: the key columns that pair the old and new rows of an update, and
-- the columns read ('*' for all). Each rule of a table is a pair: when the
-- row differs (in `o` and `n`, the old and new rows as jsonb), and the rows
-- it marks, read from `c`, the old and new versions of the differing rows as
-- `c.r`. Every statement runs through EXECUTE so it is planned for the rows
-- of this write. The planner overestimates the rules' rows many times over,
-- so a bulk write would spend about a second compiling the statement: JIT is
-- off.
CREATE FUNCTION mark_device_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET jit = off
AS $$
DECLARE
  key_list text;
  first_key text := (string_to_array(TG_ARGV[0], ','))[1];
  old_row text;
  new_row text;
  pairs text;
  rules text[];
  marks text := '';
  every_column constant text := 'o IS DISTINCT FROM n';
  -- Only rows inserted or deleted, or whose key changed.
  appears_or_disappears constant text := 'false';
  archived_changed constant text := $r$(o->'metadata'->>'legacyHidden' IS NOT DISTINCT FROM 'true')
    IS DISTINCT FROM (n->'metadata'->>'legacyHidden' IS NOT DISTINCT FROM 'true')$r$;
  -- Items credited to artists whose current profile carries one of the raw
  -- tag keys selected by %s: the items whose projected artist tags use them.
  artist_tag_items constant text := $r$SELECT mi.media_type::text, mi.id FROM {s}.media_credit mc
    JOIN {s}.media_item mi ON mi.id = mc.media_item_id
    WHERE mc.role = 'artist' AND mc.artist_id IN (
      SELECT st.artist_id FROM {s}.artist_provider_current_state st
      JOIN {s}.artist_provider_snapshot sn ON sn.id = st.latest_snapshot_id
      WHERE {s}.artist_profile_tag_keys(sn.normalized_data->'tags') && ARRAY(%s))$r$;
  -- The rows that show a media item: tracks of an album, the album of a
  -- track, playlists holding either, and the credited artists.
  media_neighbours constant text := $r$SELECT 'track', lt.media_item_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'id'
    UNION ALL SELECT 'track', t.track_media_item_id FROM c JOIN {s}.track t ON t.album_media_item_id = c.r->>'id'
    UNION ALL SELECT 'album', lt.album_media_item_id FROM c JOIN {s}.library_track lt ON lt.media_item_id = c.r->>'id'
    UNION ALL SELECT 'album', t.album_media_item_id FROM c JOIN {s}.track t ON t.track_media_item_id = c.r->>'id'
    UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'id'
    UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'id'
      JOIN {s}.playlist_item pi ON pi.media_item_id = lt.media_item_id
    UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'id'
    UNION ALL SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'id'$r$;
  -- The artists that list the playlists of `members.media_item_id`
  -- (artistPlaylistCredits, artist-library.ts): those credited with the
  -- member, and with an album that links it or lists it in its tracks.
  member_artists constant text := $r$SELECT 'artist', mc.artist_id FROM members JOIN {s}.media_credit mc ON mc.media_item_id = members.media_item_id
    UNION ALL SELECT 'artist', mc.artist_id FROM members JOIN {s}.library_track lt ON lt.media_item_id = members.media_item_id
      JOIN {s}.media_credit mc ON mc.media_item_id = lt.album_media_item_id
    UNION ALL SELECT 'artist', mc.artist_id FROM members JOIN {s}.track t ON t.track_media_item_id = members.media_item_id
      JOIN {s}.media_credit mc ON mc.media_item_id = t.album_media_item_id$r$;
  -- The rows that show the playlist memberships of `members.media_item_id`.
  member_neighbours constant text := $r$SELECT mi.media_type::text, mi.id FROM members JOIN {s}.media_item mi ON mi.id = members.media_item_id
    UNION ALL SELECT 'album', lt.album_media_item_id FROM members JOIN {s}.library_track lt ON lt.media_item_id = members.media_item_id
    UNION ALL SELECT 'album', t.album_media_item_id FROM members JOIN {s}.track t ON t.track_media_item_id = members.media_item_id
    UNION ALL $r$ || member_artists;
  -- A member that makes a playlist without a source visible to its artists
  -- (visiblePlaylist, artist-library.ts): an album, a track linked to one or
  -- a track an album lists. %1$s is the member's ID.
  shows_playlist constant text := $r$(EXISTS (SELECT 1 FROM {s}.album a WHERE a.media_item_id = %1$s)
    OR EXISTS (SELECT 1 FROM {s}.library_track t WHERE t.media_item_id = %1$s AND t.album_media_item_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM {s}.track e WHERE e.track_media_item_id = %1$s))$r$;
  -- The artists of every member of a playlist without a source that no
  -- unchanged member keeps visible: its visibility may have changed with the
  -- members `changed(playlist_id, media_item_id)` selected by %s. Followed by
  -- member_artists and the subquery's alias. Each playlist is decided once:
  -- its members are read until one outside `changed` keeps it visible. The
  -- changed members are looked up in one jsonb object, built once, whose
  -- keys are searched by bisection, so the cost is linear in the members
  -- read. A join or NOT IN against `changed`, whose size the planner cannot
  -- see, can be planned as a scan of it for every member: their square.
  playlist_visibility constant text := $r$SELECT * FROM (WITH changed AS MATERIALIZED (%s),
      playlists AS MATERIALIZED (
        SELECT p.id FROM (SELECT DISTINCT playlist_id FROM changed) f
        JOIN {s}.playlist p ON p.id = f.playlist_id AND p.kind = 'playlist' AND p.source IS NULL),
      changed_keys AS MATERIALIZED (
        SELECT coalesce(jsonb_object_agg(length(playlist_id) || ':' || playlist_id || media_item_id, true), '{}') AS keys
        FROM changed),
      kept AS MATERIALIZED (
        SELECT playlists.id FROM playlists CROSS JOIN changed_keys CROSS JOIN LATERAL (
          SELECT 1 FROM {s}.playlist_item other
          WHERE other.playlist_id = playlists.id
            AND NOT changed_keys.keys ? (length(other.playlist_id) || ':' || other.playlist_id || other.media_item_id)
            AND $r$ || format(shows_playlist, 'other.media_item_id') || $r$
          LIMIT 1) found),
      members AS MATERIALIZED (
        SELECT member.media_item_id FROM playlists
        JOIN {s}.playlist_item member ON member.playlist_id = playlists.id
        WHERE NOT EXISTS (SELECT 1 FROM kept WHERE kept.id = playlists.id))
    $r$;
  -- The memberships of the item in column %L of `c.r`, as `changed`.
  holding_playlists constant text := $r$SELECT pi.playlist_id, pi.media_item_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>%L$r$;
  -- The scrobbled names linked to the track in column %L of `c.r`: each is
  -- published while a linked track is in the library.
  linked_names constant text := $r$SELECT 'scrobble_name', {s}.device_scrobble_name_id(l.username, l.artist_key, l.track_key) FROM c
    JOIN {s}.lastfm_track_link l ON l.track_media_item_id = c.r->>%L$r$;
  -- The plays of the album in column %L of `c.r`, when it has a scrobble.
  album_plays constant text := $r$SELECT 'album_plays', c.r->>%1$L FROM c
    WHERE EXISTS (SELECT 1 FROM {s}.lastfm_scrobble s WHERE s.album_media_item_id = c.r->>%1$L)$r$;
  -- The media item named by `c.r->>'media_item_id'`, as its own entity.
  owning_item constant text := $r$SELECT mi.media_type::text, mi.id FROM c JOIN {s}.media_item mi ON mi.id = c.r->>'media_item_id'$r$;
BEGIN
  rules := CASE TG_TABLE_NAME
    WHEN 'media_item' THEN ARRAY[
      every_column, $r$SELECT c.r->>'media_type', c.r->>'id' FROM c$r$,
      $r$o->'title' IS DISTINCT FROM n->'title' OR o->'slug' IS DISTINCT FROM n->'slug'
        OR o->'media_type' IS DISTINCT FROM n->'media_type' OR o->'release_date' IS DISTINCT FROM n->'release_date'
        OR o->'artwork_url' IS DISTINCT FROM n->'artwork_url' OR o->'source_label' IS DISTINCT FROM n->'source_label'
        OR o->'in_library' IS DISTINCT FROM n->'in_library'
        OR $r$ || archived_changed,
      media_neighbours,
      -- Publication: names and album plays are published for items in the
      -- library; playlists count albums in the library, including through
      -- their track lists; artists list a playlist through a member that is
      -- not archived, on the member's albums too.
      $r$o->'in_library' IS DISTINCT FROM n->'in_library'
        OR o->'media_type' IS DISTINCT FROM n->'media_type' OR $r$ || archived_changed,
      format(linked_names, 'id') || ' UNION ALL ' || format(album_plays, 'id') || $r$
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.track t ON t.album_media_item_id = c.r->>'id'
          JOIN {s}.playlist_item pi ON pi.media_item_id = t.track_media_item_id
        UNION ALL SELECT * FROM (WITH members AS MATERIALIZED (
            SELECT pi.media_item_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'id')
          $r$ || member_artists || ') changed_members']
    WHEN 'library_track' THEN ARRAY[
      every_column, $r$SELECT 'track', c.r->>'media_item_id' FROM c$r$,
      $r$o->'media_item_id' IS DISTINCT FROM n->'media_item_id'
        OR o->'album_media_item_id' IS DISTINCT FROM n->'album_media_item_id'
        OR o->'duration_sec' IS DISTINCT FROM n->'duration_sec'
        OR o->'spotify_album_id' IS DISTINCT FROM n->'spotify_album_id'
        OR o->'spotify_track_id' IS DISTINCT FROM n->'spotify_track_id'
        OR o->'album_link_strategy' IS DISTINCT FROM n->'album_link_strategy'$r$,
      $r$SELECT 'album', c.r->>'album_media_item_id' FROM c
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'media_item_id'
        UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'media_item_id'
        UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'album_media_item_id'
        UNION ALL SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'media_item_id'$r$,
      -- A name is published while a linked track is a library track.
      appears_or_disappears, format(linked_names, 'media_item_id'),
      $r$(o->>'album_media_item_id' IS NULL) IS DISTINCT FROM (n->>'album_media_item_id' IS NULL)$r$,
      format(playlist_visibility, format(holding_playlists, 'media_item_id')) || member_artists || ') linked_members']
    WHEN 'album' THEN ARRAY[
      every_column, $r$SELECT 'album', c.r->>'media_item_id' FROM c
        UNION ALL SELECT 'album', c.r->>'edition_of_id' FROM c$r$,
      $r$o->'media_item_id' IS DISTINCT FROM n->'media_item_id'
        OR o->'edition_of_id' IS DISTINCT FROM n->'edition_of_id'
        OR o->'track_count' IS DISTINCT FROM n->'track_count'$r$,
      -- A playlist's presentation reads the length of each album that lists
      -- one of its members.
      $r$SELECT 'track', lt.media_item_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'media_item_id'
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'media_item_id'
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'media_item_id'
          JOIN {s}.playlist_item pi ON pi.media_item_id = lt.media_item_id
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.track t ON t.album_media_item_id = c.r->>'media_item_id'
          JOIN {s}.playlist_item pi ON pi.media_item_id = t.track_media_item_id
        UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'media_item_id'$r$,
      -- Albums count for their artists' scope and plays, and show playlists.
      appears_or_disappears,
      $r$SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'media_item_id'
        UNION ALL $r$ || format(album_plays, 'media_item_id') || ' UNION ALL '
        || format(playlist_visibility, format(holding_playlists, 'media_item_id')) || member_artists || ') album_members']
    WHEN 'film' THEN ARRAY[
      every_column, $r$SELECT 'film', c.r->>'media_item_id' FROM c$r$]
    WHEN 'track' THEN ARRAY[
      every_column, $r$SELECT 'track', c.r->>'track_media_item_id' FROM c
        UNION ALL SELECT 'album', c.r->>'album_media_item_id' FROM c
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'track_media_item_id'
        UNION ALL SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.playlist_item pi ON pi.media_item_id = c.r->>'album_media_item_id'
        UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'track_media_item_id'
        UNION ALL SELECT 'artist', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'album_media_item_id'$r$,
      -- An album's length counts its listed tracks, for the playlists
      -- holding any of them.
      $r$o->'album_media_item_id' IS DISTINCT FROM n->'album_media_item_id'$r$,
      $r$SELECT 'playlist', pi.playlist_id FROM c JOIN {s}.track t ON t.album_media_item_id = c.r->>'album_media_item_id'
        JOIN {s}.playlist_item pi ON pi.media_item_id = t.track_media_item_id$r$,
      $r$o->'track_media_item_id' IS DISTINCT FROM n->'track_media_item_id'$r$,
      format(playlist_visibility, format(holding_playlists, 'track_media_item_id')) || member_artists || ') listed_members']
    WHEN 'media_credit' THEN ARRAY[
      every_column, owning_item || $r$
        UNION ALL SELECT 'artist', c.r->>'artist_id' FROM c
        UNION ALL SELECT 'artist_plays', c.r->>'artist_id' FROM c
        UNION ALL SELECT 'track', lt.media_item_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'media_item_id'$r$]
    WHEN 'artist' THEN ARRAY[
      every_column, $r$SELECT 'artist', c.r->>'id' FROM c
        UNION ALL SELECT 'artist', c.r->>'merged_into_id' FROM c$r$,
      $r$o->'name' IS DISTINCT FROM n->'name' OR o->'merged_into_id' IS DISTINCT FROM n->'merged_into_id'$r$,
      $r$SELECT mi.media_type::text, mi.id FROM c JOIN {s}.media_credit mc ON mc.artist_id = c.r->>'id'
          JOIN {s}.media_item mi ON mi.id = mc.media_item_id
        UNION ALL SELECT 'track', lt.media_item_id FROM c JOIN {s}.media_credit mc ON mc.artist_id = c.r->>'id'
          JOIN {s}.library_track lt ON lt.album_media_item_id = mc.media_item_id
        UNION ALL SELECT 'artist_plays', c.r->>'id' FROM c
        UNION ALL SELECT 'artist_plays', c.r->>'merged_into_id' FROM c$r$,
      -- An added artist, or the artist it is merged into, is in scope.
      $r$o->'added_to_library' IS DISTINCT FROM n->'added_to_library'$r$,
      $r$SELECT 'artist_plays', c.r->>'id' FROM c
        UNION ALL SELECT 'artist_plays', c.r->>'merged_into_id' FROM c$r$]
    WHEN 'artist_provider_current_state' THEN ARRAY[
      every_column, $r$SELECT 'artist', c.r->>'artist_id' FROM c
        UNION ALL SELECT mi.media_type::text, mi.id FROM c
          JOIN {s}.media_credit mc ON mc.artist_id = c.r->>'artist_id' AND mc.role = 'artist'
          JOIN {s}.media_item mi ON mi.id = mc.media_item_id$r$]
    WHEN 'artist_provider_snapshot' THEN ARRAY[
      every_column, $r$SELECT 'artist', c.r->>'artist_id' FROM c
        UNION ALL SELECT mi.media_type::text, mi.id FROM c
          JOIN {s}.artist_provider_current_state st
            ON st.artist_id = c.r->>'artist_id' AND st.latest_snapshot_id = c.r->>'id'
          JOIN {s}.media_credit mc ON mc.artist_id = st.artist_id AND mc.role = 'artist'
          JOIN {s}.media_item mi ON mi.id = mc.media_item_id$r$]
    WHEN 'tag' THEN ARRAY[
      every_column, $r$SELECT 'tag', c.r->>'id' FROM c$r$,
      $r$o->'name' IS DISTINCT FROM n->'name' OR o->'hidden' IS DISTINCT FROM n->'hidden'
        OR o->'media_type' IS DISTINCT FROM n->'media_type'$r$,
      $r$SELECT mi.media_type::text, mi.id FROM c JOIN {s}.media_item_tag mit ON mit.tag_id = c.r->>'id'
          JOIN {s}.media_item mi ON mi.id = mit.media_item_id
        UNION ALL SELECT 'track', lt.media_item_id FROM c JOIN {s}.media_item_tag mit ON mit.tag_id = c.r->>'id'
          JOIN {s}.library_track lt ON lt.album_media_item_id = mit.media_item_id
        UNION ALL SELECT 'track', tt.media_item_id FROM c JOIN {s}.track_tag tt ON tt.tag_id = c.r->>'id' AND tt.in_browse
        UNION ALL SELECT 'album', lt.album_media_item_id FROM c
          JOIN {s}.track_tag tt ON tt.tag_id = c.r->>'id' AND tt.in_browse
          JOIN {s}.library_track lt ON lt.media_item_id = tt.media_item_id
        UNION ALL $r$ || format(artist_tag_items, $r$
          SELECT unnest({s}.artist_profile_tag_keys(jsonb_agg(k.name))) FROM (
            SELECT c.r->>'name' AS name FROM c WHERE c.r->>'media_type' = 'album'
            UNION ALL SELECT t.name FROM c JOIN {s}.tag_alias a ON a.target_tag_id = c.r->>'id'
              JOIN {s}.tag t ON t.id = a.source_tag_id) k
          UNION SELECT ti.normalized_name FROM c JOIN {s}.tag_identity ti ON ti.tag_id = c.r->>'id'$r$)]
    WHEN 'tag_alias' THEN ARRAY[
      every_column, $r$SELECT 'tag', c.r->>'source_tag_id' FROM c
        UNION ALL SELECT 'tag', c.r->>'target_tag_id' FROM c
        UNION ALL $r$ || format(artist_tag_items, $r$
          SELECT unnest({s}.artist_profile_tag_keys(jsonb_agg(t.name))) FROM c
            JOIN {s}.tag t ON t.id IN (c.r->>'source_tag_id', c.r->>'target_tag_id') WHERE t.media_type = 'album'
          UNION SELECT ti.normalized_name FROM c
            JOIN {s}.tag_identity ti ON ti.tag_id IN (c.r->>'source_tag_id', c.r->>'target_tag_id')$r$)]
    WHEN 'tag_identity' THEN ARRAY[
      every_column, $r$SELECT 'tag', c.r->>'tag_id' FROM c
        UNION ALL $r$ || format(artist_tag_items, $r$
          SELECT c.r->>'normalized_name' FROM c WHERE c.r->>'media_type' = 'album'
          UNION SELECT unnest({s}.artist_profile_tag_keys(jsonb_agg(t.name))) FROM c
            JOIN {s}.tag t ON t.id = c.r->>'tag_id' WHERE t.media_type = 'album'$r$)]
    WHEN 'tag_parent' THEN ARRAY[
      every_column, $r$SELECT 'tag_key', (c.r->>'media_type') || ':' || (c.r->>'child_key') FROM c$r$]
    WHEN 'tag_ancestor' THEN ARRAY[
      every_column, $r$SELECT 'tag_key', (c.r->>'media_type') || ':' || (c.r->>'descendant_key') FROM c$r$]
    WHEN 'media_item_tag' THEN ARRAY[
      every_column, owning_item || $r$
        UNION ALL SELECT 'track', lt.media_item_id FROM c JOIN {s}.library_track lt ON lt.album_media_item_id = c.r->>'media_item_id'$r$]
    WHEN 'track_tag' THEN ARRAY[
      every_column, $r$SELECT 'track', c.r->>'media_item_id' FROM c
        UNION ALL SELECT 'album', lt.album_media_item_id FROM c JOIN {s}.library_track lt ON lt.media_item_id = c.r->>'media_item_id'$r$,
      -- A tag's `sonovault` reads the in-Browse Sonovault tags of every
      -- library track, published or not: mark the tag of each such row
      -- that appears, disappears or changes.
      $r$o->'tag_id' IS DISTINCT FROM n->'tag_id' OR o->'in_browse' IS DISTINCT FROM n->'in_browse'
        OR o->'sonovault' IS DISTINCT FROM n->'sonovault'$r$,
      $r$SELECT 'tag', c.r->>'tag_id' FROM c WHERE c.r->>'in_browse' = 'true' AND c.r->>'sonovault' = 'true'$r$]
    WHEN 'tag_occurrence' THEN ARRAY[every_column, owning_item]
    WHEN 'playlist' THEN ARRAY[
      every_column, $r$SELECT 'playlist', c.r->>'id' FROM c$r$,
      $r$o->'name' IS DISTINCT FROM n->'name' OR o->'kind' IS DISTINCT FROM n->'kind'
        OR o->'source' IS DISTINCT FROM n->'source' OR o->'spotify_id' IS DISTINCT FROM n->'spotify_id'
        OR o->'added_to_library' IS DISTINCT FROM n->'added_to_library'
        OR o->'catalog_provider' IS DISTINCT FROM n->'catalog_provider'$r$,
      $r$SELECT * FROM (WITH members AS MATERIALIZED (
          SELECT pi.media_item_id FROM c JOIN {s}.playlist_item pi ON pi.playlist_id = c.r->>'id')
        $r$ || member_neighbours || ') members_of_playlists']
    WHEN 'playlist_item' THEN ARRAY[
      every_column, $r$SELECT 'playlist', c.r->>'playlist_id' FROM c$r$,
      $r$o->'playlist_id' IS DISTINCT FROM n->'playlist_id' OR o->'media_item_id' IS DISTINCT FROM n->'media_item_id'
        OR o->'admits_to_library' IS DISTINCT FROM n->'admits_to_library'$r$,
      $r$SELECT * FROM (WITH members AS MATERIALIZED (SELECT c.r->>'media_item_id' AS media_item_id FROM c)
        $r$ || member_neighbours || ') changed_members',
      -- A member that shows its playlist can be the only one.
      appears_or_disappears,
      format(playlist_visibility, $r$SELECT c.r->>'playlist_id' AS playlist_id, c.r->>'media_item_id' AS media_item_id
        FROM c WHERE $r$ || format(shows_playlist, $r$(c.r->>'media_item_id')$r$))
        || member_artists || ') visible_members']
    WHEN 'provider_reference' THEN ARRAY[every_column, owning_item]
    WHEN 'provider_reference_override' THEN ARRAY[every_column, owning_item]
    WHEN 'external_link' THEN ARRAY[every_column, owning_item]
    WHEN 'media_override' THEN ARRAY[every_column, owning_item]
    WHEN 'track_fact' THEN ARRAY[every_column, $r$SELECT 'track', c.r->>'media_item_id' FROM c$r$]
    WHEN 'lastfm_track_source' THEN ARRAY[
      every_column, $r$SELECT 'track', c.r->>'track_media_item_id' FROM c$r$]
    WHEN 'lastfm_track_link' THEN ARRAY[
      every_column, $r$SELECT 'track', c.r->>'track_media_item_id' FROM c
        UNION ALL SELECT 'track', other.track_media_item_id FROM c JOIN {s}.lastfm_track_source other
          ON (other.username, other.artist_key, other.track_key) = (c.r->>'username', c.r->>'artist_key', c.r->>'track_key')
        UNION ALL SELECT 'track', other.track_media_item_id FROM c JOIN {s}.lastfm_track_link other
          ON (other.username, other.artist_key, other.track_key) = (c.r->>'username', c.r->>'artist_key', c.r->>'track_key')
        UNION ALL SELECT 'scrobble_name', {s}.device_scrobble_name_id(c.r->>'username', c.r->>'artist_key', c.r->>'track_key') FROM c
        UNION ALL SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'track_media_item_id'$r$]
    WHEN 'lastfm_scrobble' THEN ARRAY[
      every_column, $r$SELECT 'scrobble_name', {s}.device_scrobble_name_id(c.r->>'username', c.r->>'artist_key', c.r->>'track_key') FROM c
        UNION ALL SELECT 'album_plays', c.r->>'album_media_item_id' FROM c
        UNION ALL SELECT 'album', c.r->>'album_media_item_id' FROM c
        UNION ALL SELECT 'meta', 'listening' FROM c
        UNION ALL SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.media_credit mc ON mc.media_item_id = c.r->>'album_media_item_id'
        UNION ALL SELECT 'artist_plays', mc.artist_id FROM c JOIN {s}.lastfm_track_link l
            ON (l.username, l.artist_key, l.track_key) = (c.r->>'username', c.r->>'artist_key', c.r->>'track_key')
          JOIN {s}.media_credit mc ON mc.media_item_id = l.track_media_item_id$r$]
    -- An observed artist, or the artist it is merged into, is in scope.
    WHEN 'catalog_observation' THEN ARRAY[
      every_column, $r$SELECT kind.entity, observed.id FROM c
        CROSS JOIN LATERAL (SELECT c.r->>'target_id' AS id
          UNION ALL SELECT a.merged_into_id FROM {s}.artist a WHERE a.id = c.r->>'target_id') observed
        CROSS JOIN (VALUES ('artist'), ('artist_plays')) kind(entity)
        WHERE c.r->>'target_kind' = 'artist'$r$]
    -- Progress writes of a queued or running import leave its row unchanged.
    WHEN 'scrape_job' THEN ARRAY[
      $r$o->>'status' NOT IN ('queued', 'running') OR n->>'status' NOT IN ('queued', 'running')
        OR (o - 'options') IS DISTINCT FROM (n - 'options')
        OR (o->'options') - '{progress,activity}'::text[] IS DISTINCT FROM (n->'options') - '{progress,activity}'::text[]$r$,
      $r$SELECT 'playlist_job', c.r->'options'->>'groupKey' FROM c
        WHERE c.r->>'provider' = 'spotify' AND c.r->'options'->>'task' = 'spotify-playlist-import'$r$]
  END;
  IF rules IS NULL OR TG_NARGS <> 2 THEN
    RAISE EXCEPTION 'Unexpected device feed trigger on %', TG_TABLE_NAME;
  END IF;

  SELECT string_agg(format('%I', field), ', ') INTO key_list
    FROM unnest(string_to_array(TG_ARGV[0], ',')) AS field;
  IF TG_ARGV[1] = '*' THEN
    old_row := 'to_jsonb(o)';
    new_row := 'to_jsonb(n)';
  ELSE
    SELECT 'jsonb_build_object(' || string_agg(format('%L, o.%I', field, field), ', ') || ')',
        'jsonb_build_object(' || string_agg(format('%L, n.%I', field, field), ', ') || ')'
      INTO old_row, new_row FROM unnest(string_to_array(TG_ARGV[1], ',')) AS field;
  END IF;
  pairs := CASE TG_OP
    WHEN 'INSERT' THEN format('SELECT NULL::jsonb AS o, %s AS n FROM new_rows n', new_row)
    WHEN 'DELETE' THEN format('SELECT %s AS o, NULL::jsonb AS n FROM old_rows o', old_row)
    ELSE format('SELECT CASE WHEN o.%2$I IS NULL THEN NULL ELSE %3$s END AS o,
        CASE WHEN n.%2$I IS NULL THEN NULL ELSE %4$s END AS n
      FROM old_rows o FULL JOIN new_rows n USING (%1$s)', key_list, first_key, old_row, new_row)
  END;

  FOR rule IN 1 .. array_length(rules, 1) / 2 LOOP
    marks := marks || CASE WHEN rule > 1 THEN ' UNION ALL ' ELSE '' END || format(
      'SELECT * FROM (WITH c AS MATERIALIZED (
          SELECT o AS r FROM pairs WHERE o IS NOT NULL AND (n IS NULL OR %1$s)
          UNION ALL SELECT n FROM pairs WHERE n IS NOT NULL AND (o IS NULL OR %1$s))
        %2$s) rule_%3$s', rules[2 * rule - 1], rules[2 * rule], rule);
  END LOOP;

  EXECUTE replace(format('WITH pairs AS MATERIALIZED (%s), marks(entity, id) AS (%s)
    INSERT INTO {s}.device_dirty (entity, id)
    SELECT DISTINCT entity, id FROM marks WHERE entity IS NOT NULL AND id IS NOT NULL AND id <> %L',
    pairs, marks, ''), '{s}.', quote_ident(TG_TABLE_SCHEMA) || '.');
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION mark_device_dirty() FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE
  source record;
  operation text;
  transition text;
BEGIN
  FOR source IN
    SELECT * FROM (VALUES
      ('media_item', 'id', '*'),
      ('library_track', 'media_item_id', '*'),
      ('album', 'media_item_id', '*'),
      ('film', 'media_item_id', '*'),
      ('track', 'id', '*'),
      ('media_credit', 'media_item_id,artist_id,role', '*'),
      ('artist', 'id', '*'),
      ('artist_provider_current_state', 'artist_id,provider', 'artist_id,provider,latest_snapshot_id'),
      ('artist_provider_snapshot', 'id', 'id,artist_id,normalized_data'),
      ('tag', 'id', '*'),
      ('tag_alias', 'source_tag_id', '*'),
      ('tag_identity', 'media_type,normalized_name,kind', '*'),
      ('tag_parent', 'media_type,child_key,parent_key', '*'),
      ('tag_ancestor', 'media_type,descendant_key,ancestor_key', '*'),
      ('media_item_tag', 'media_item_id,tag_id', '*'),
      ('track_tag', 'media_item_id,tag_id', '*'),
      ('tag_occurrence', 'id', '*'),
      ('playlist', 'id', '*'),
      ('playlist_item', 'playlist_id,media_item_id', '*'),
      ('provider_reference', 'id', '*'),
      ('provider_reference_override', 'id', '*'),
      ('external_link', 'id', '*'),
      ('media_override', 'id', '*'),
      ('track_fact', 'media_item_id,provider', '*'),
      ('lastfm_track_source', 'username,artist_key,track_key', '*'),
      ('lastfm_track_link', 'username,artist_key,track_key,track_media_item_id', '*'),
      ('lastfm_scrobble', 'id', 'id,username,listened_at,artist_key,track_key,album_media_item_id'),
      ('catalog_observation', 'id', 'id,target_kind,target_id'),
      ('scrape_job', 'id', 'id,provider,status,options,error_message,finished_at,created_at')
    ) AS sources(table_name, key_columns, compared_columns)
  LOOP
    FOREACH operation IN ARRAY ARRAY['insert', 'update', 'delete'] LOOP
      transition := CASE operation
        WHEN 'insert' THEN 'NEW TABLE AS new_rows'
        WHEN 'delete' THEN 'OLD TABLE AS old_rows'
        ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows'
      END;
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s
         FOR EACH STATEMENT EXECUTE FUNCTION mark_device_dirty(%L, %L)',
        'device_dirty_' || source.table_name || '_' || operation, upper(operation),
        source.table_name, transition, source.key_columns, source.compared_columns);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_runtime') THEN
    -- The render marks again the rows a deadline left unresolved.
    GRANT SELECT, INSERT, DELETE ON device_dirty TO media_runtime;
    GRANT USAGE ON SEQUENCE device_dirty_key_seq TO media_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON device_row TO media_runtime;
    GRANT SELECT, UPDATE ON device_feed_state TO media_runtime;
    GRANT USAGE ON SEQUENCE device_row_seq TO media_runtime;
  END IF;
END;
$$;
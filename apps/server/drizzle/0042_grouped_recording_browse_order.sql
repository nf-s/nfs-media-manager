CREATE TABLE "recording_browse_order" (
	"id" text PRIMARY KEY NOT NULL,
	"version_count" integer NOT NULL,
	"scrobbles" integer NOT NULL,
	"last_listened_at" timestamp,
	"date_added" timestamp,
	"ascending_rank" integer NOT NULL,
	"descending_rank" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_browse_order_dirty" (
	"transaction_id" bigint PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_browse_order_state" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"builder" text NOT NULL,
	"total_count" integer,
	"retry_after" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recording_browse_order_ascending_idx" ON "recording_browse_order" USING btree ("ascending_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_browse_order_descending_idx" ON "recording_browse_order" USING btree ("descending_rank");
--> statement-breakpoint
-- Source rows and their dirty marker commit together. Replacing a few older
-- markers bounds backlog even when the affected Browse cache is unused.
CREATE FUNCTION mark_browse_cache_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  writes integer;
  writer bigint := txid_current();
  markers text := format('%I.%I', TG_TABLE_SCHEMA, TG_ARGV[0]);
BEGIN
  EXECUTE format('INSERT INTO %s (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING', markers)
    USING writer;
  GET DIAGNOSTICS writes = ROW_COUNT;
  IF writes > 0 THEN
    EXECUTE format('DELETE FROM %1$s WHERE transaction_id IN (
      SELECT transaction_id FROM %1$s WHERE transaction_id <> $1
      ORDER BY transaction_id LIMIT 8 FOR UPDATE SKIP LOCKED
    )', markers) USING writer;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER recording_browse_order_media_item
AFTER INSERT OR UPDATE OF id, media_type, title, release_date, source_label, metadata OR DELETE OR TRUNCATE ON "media_item"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_library_track
AFTER INSERT OR UPDATE OF media_item_id, spotify_track_id, isrc, duration_sec, date_added, album_name, spotify_album_id, album_media_item_id, scrobble_count, last_listened_at OR DELETE OR TRUNCATE ON "library_track"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_artist
AFTER INSERT OR UPDATE OF id, name OR DELETE OR TRUNCATE ON "artist"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_media_credit
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "media_credit"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_track
AFTER INSERT OR UPDATE OF album_media_item_id, track_media_item_id, position, duration_sec OR DELETE OR TRUNCATE ON "track"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_album
AFTER UPDATE OF media_item_id OR DELETE OR TRUNCATE ON "album"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_track_link
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lastfm_track_link"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_track_source
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lastfm_track_source"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_scrobble
AFTER INSERT OR UPDATE OF username, artist_key, track_key, listened_at OR DELETE OR TRUNCATE ON "lastfm_scrobble"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_playlist_item
AFTER INSERT OR UPDATE OF playlist_id, media_item_id OR DELETE OR TRUNCATE ON "playlist_item"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
CREATE TRIGGER recording_browse_order_playlist
AFTER UPDATE OF id OR DELETE OR TRUNCATE ON "playlist"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION mark_browse_cache_dirty() FROM PUBLIC;

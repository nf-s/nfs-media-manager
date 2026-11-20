CREATE TABLE "track_facet_dirty" (
	"transaction_id" bigint PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_facet_state" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"builder" text NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"retry_after" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_facet_value" (
	"field" text NOT NULL,
	"rank" bigint NOT NULL,
	"value" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "track_facet_value_field_rank_pk" PRIMARY KEY("field","rank")
);
--> statement-breakpoint
-- Track facet values depend on stored titles, credits, releases, playlists,
-- current artist profiles, album tag rules and retained Last.fm membership.
CREATE TRIGGER track_facet_media_item
AFTER INSERT OR UPDATE OF id, media_type, title, source_label, metadata OR DELETE OR TRUNCATE ON "media_item"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_library_track
AFTER INSERT OR UPDATE OF media_item_id, album_media_item_id, album_name, spotify_track_id OR DELETE OR TRUNCATE ON "library_track"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_media_credit
AFTER INSERT OR UPDATE OF media_item_id, artist_id, role OR DELETE OR TRUNCATE ON "media_credit"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_artist_provider_current_state
AFTER INSERT OR UPDATE OF artist_id, latest_snapshot_id OR DELETE OR TRUNCATE ON "artist_provider_current_state"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_artist_provider_snapshot
AFTER INSERT OR UPDATE OF id, normalized_data OR DELETE OR TRUNCATE ON "artist_provider_snapshot"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_tag
AFTER INSERT OR UPDATE OF id, media_type, name, hidden OR DELETE OR TRUNCATE ON "tag"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_tag_identity
AFTER INSERT OR UPDATE OF tag_id, media_type, normalized_name OR DELETE OR TRUNCATE ON "tag_identity"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_tag_alias
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "tag_alias"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_tag_ancestor
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "tag_ancestor"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_media_item_tag
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "media_item_tag"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_track
AFTER INSERT OR UPDATE OF track_media_item_id OR DELETE OR TRUNCATE ON "track"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_lastfm_track_link
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lastfm_track_link"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_lastfm_track_source
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lastfm_track_source"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_playlist_item
AFTER INSERT OR UPDATE OF media_item_id, playlist_id OR DELETE OR TRUNCATE ON "playlist_item"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_playlist
AFTER INSERT OR UPDATE OF id, name, kind, source OR DELETE OR TRUNCATE ON "playlist"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_album
AFTER INSERT OR UPDATE OF media_item_id OR DELETE OR TRUNCATE ON "album"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');--> statement-breakpoint
CREATE TRIGGER track_facet_artist
AFTER INSERT OR UPDATE OF id, name OR DELETE OR TRUNCATE ON "artist"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');

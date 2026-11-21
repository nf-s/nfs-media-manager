-- Stored versions decide recording groups and the row each group is shown
-- as, so the grouped order is stale when either column changes.
DROP TRIGGER recording_browse_order_library_track_insert ON library_track;
--> statement-breakpoint
DROP TRIGGER recording_browse_order_library_track_update ON library_track;
--> statement-breakpoint
DROP TRIGGER recording_browse_order_library_track_delete ON library_track;
--> statement-breakpoint
CREATE TRIGGER recording_browse_order_library_track_insert AFTER INSERT ON library_track
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty', 'media_item_id', 'media_item_id,spotify_track_id,isrc,duration_sec,date_added,album_name,spotify_album_id,album_media_item_id,scrobble_count,last_listened_at,version_group_id,version_shown');
--> statement-breakpoint
CREATE TRIGGER recording_browse_order_library_track_update AFTER UPDATE ON library_track
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty', 'media_item_id', 'media_item_id,spotify_track_id,isrc,duration_sec,date_added,album_name,spotify_album_id,album_media_item_id,scrobble_count,last_listened_at,version_group_id,version_shown');
--> statement-breakpoint
CREATE TRIGGER recording_browse_order_library_track_delete AFTER DELETE ON library_track
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty', 'media_item_id', 'media_item_id,spotify_track_id,isrc,duration_sec,date_added,album_name,spotify_album_id,album_media_item_id,scrobble_count,last_listened_at,version_group_id,version_shown');

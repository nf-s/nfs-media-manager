-- Keep the existing dirty-marker protocol, but ignore empty writes and
-- updates that leave the columns used by each cache unchanged.
DO $$
DECLARE
  source record;
BEGIN
  FOR source IN
    SELECT * FROM (VALUES
      ('artist', 'track_facet_artist', 'track_facet_dirty',
        'id', 'id,name'),
      ('artist', 'recording_browse_order_artist', 'recording_browse_order_dirty',
        'id', 'id,name'),
      ('track', 'track_facet_track', 'track_facet_dirty',
        'id', 'track_media_item_id'),
      ('track', 'recording_browse_order_track', 'recording_browse_order_dirty',
        'id', 'album_media_item_id,track_media_item_id,position,duration_sec'),
      ('lastfm_scrobble', 'recording_browse_order_scrobble', 'recording_browse_order_dirty',
        'id', 'username,artist_key,track_key,listened_at')
    ) AS sources(table_name, trigger_name, marker_table, key_columns, compared_columns)
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I AFTER TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L)',
      source.trigger_name, source.table_name, source.marker_table);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_insert', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_update', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_delete', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
  END LOOP;
END;
$$;

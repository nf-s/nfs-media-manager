-- A statement written directly in a trigger function keeps the plan of the
-- session's first write. One planned for a one-row update compared every old
-- row with every new row of a later bulk update on the same session. EXECUTE
-- plans each statement for the rows of its own write.
CREATE OR REPLACE FUNCTION drop_track_duplicate_groups() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dropped integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('DELETE FROM %1$I.track_duplicate_group g
      USING %1$I.track_duplicate_member m, old_rows o
      WHERE m.group_id = g.id AND m.track_id = o.media_item_id', TG_TABLE_SCHEMA);
  ELSE
    EXECUTE format('DELETE FROM %1$I.track_duplicate_group g
      USING %1$I.track_duplicate_member m, old_rows o
        JOIN new_rows n USING (media_item_id)
      WHERE m.group_id = g.id AND m.track_id = n.media_item_id
        AND o.version_group_id IS DISTINCT FROM n.version_group_id', TG_TABLE_SCHEMA);
  END IF;
  GET DIAGNOSTICS dropped = ROW_COUNT;
  IF dropped > 0 THEN
    EXECUTE format('UPDATE %1$I.track_duplicate_state
      SET group_count = (SELECT count(*) FROM %1$I.track_duplicate_group)
      WHERE singleton AND group_count IS NOT NULL', TG_TABLE_SCHEMA);
  END IF;
  RETURN NULL;
END;
$$;

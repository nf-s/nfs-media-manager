-- Apply transactionally after backup; coordinate the application cutover with tag writers.
SELECT pg_advisory_xact_lock(72041, 1);
--> statement-breakpoint
LOCK TABLE "tag", "tag_identity", "tag_alias", "tag_merge", "media_item_tag", "tag_occurrence" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "tag" ADD COLUMN "media_type" "media_type";
--> statement-breakpoint
ALTER TABLE "tag_identity" ADD COLUMN "media_type" "media_type";
--> statement-breakpoint
DROP INDEX "tag_name_kind_uidx";
--> statement-breakpoint
ALTER TABLE "tag_identity" DROP CONSTRAINT "tag_identity_normalized_name_kind_pk";
--> statement-breakpoint
-- Preserve complete historical groups, including same-name cross-kind rows.
CREATE TEMPORARY TABLE tag_scope_map ON COMMIT DROP AS
WITH RECURSIVE names AS (
  SELECT id, lower(btrim(regexp_replace(normalize(name, NFC), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'))) AS normalized_name
  FROM tag
), edges AS (
  SELECT source_tag_id AS a, target_tag_id AS b FROM tag_alias
  UNION SELECT source_tag_id, target_tag_id FROM tag_merge
  UNION SELECT n.id, first_value(n.id) OVER (PARTITION BY n.normalized_name ORDER BY n.id) FROM names n
), both_edges AS (
  SELECT a, b FROM edges UNION SELECT b, a FROM edges
), scopes(id, media_type) AS (
  (SELECT mt.tag_id, m.media_type FROM media_item_tag mt JOIN media_item m ON m.id = mt.media_item_id
   UNION SELECT o.tag_id, m.media_type FROM tag_occurrence o JOIN media_item m ON m.id = o.media_item_id)
  UNION
  SELECT e.b, s.media_type FROM scopes s JOIN both_edges e ON e.a = s.id
), complete AS (
  SELECT id, media_type FROM scopes
  UNION
  -- Unattached groups retain prior intent in both libraries without invented memberships.
  SELECT t.id, medium FROM tag t CROSS JOIN unnest(enum_range(NULL::media_type)) medium
  WHERE NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = t.id)
)
SELECT id AS old_id, media_type,
       CASE WHEN media_type = 'film' OR NOT EXISTS (SELECT 1 FROM complete other WHERE other.id = c.id AND other.media_type = 'film')
            THEN id ELSE 'tag_scope_album_' || md5(id) END AS new_id
FROM complete c;
--> statement-breakpoint
CREATE UNIQUE INDEX ON tag_scope_map(old_id, media_type);
--> statement-breakpoint
CREATE TEMPORARY TABLE tag_scope_identity ON COMMIT DROP AS SELECT * FROM tag_identity;
--> statement-breakpoint
CREATE TEMPORARY TABLE tag_scope_alias ON COMMIT DROP AS SELECT * FROM tag_alias;
--> statement-breakpoint
CREATE TEMPORARY TABLE tag_scope_merge ON COMMIT DROP AS SELECT * FROM tag_merge;
--> statement-breakpoint
UPDATE tag t SET media_type = m.media_type FROM tag_scope_map m WHERE t.id = m.old_id AND m.new_id = m.old_id;
--> statement-breakpoint
INSERT INTO tag (id, media_type, name, kind, hidden, created_at, updated_at)
SELECT m.new_id, m.media_type, t.name, t.kind, t.hidden, t.created_at, t.updated_at
FROM tag_scope_map m JOIN tag t ON t.id = m.old_id WHERE m.new_id <> m.old_id;
--> statement-breakpoint
UPDATE media_item_tag mt SET tag_id = mapping.new_id
FROM tag_scope_map mapping, media_item item
WHERE mt.tag_id = mapping.old_id AND mt.media_item_id = item.id AND mapping.media_type = item.media_type;
--> statement-breakpoint
UPDATE tag_occurrence o SET tag_id = mapping.new_id
FROM tag_scope_map mapping, media_item item
WHERE o.tag_id = mapping.old_id AND o.media_item_id = item.id AND mapping.media_type = item.media_type;
--> statement-breakpoint
DELETE FROM tag_identity;
--> statement-breakpoint
INSERT INTO tag_identity (media_type, normalized_name, kind, tag_id)
SELECT m.media_type, i.normalized_name, i.kind, m.new_id
FROM tag_scope_identity i JOIN tag_scope_map m ON m.old_id = i.tag_id;
--> statement-breakpoint
INSERT INTO tag_alias (source_tag_id, target_tag_id, created_at)
SELECT s.new_id, t.new_id, a.created_at
FROM tag_scope_alias a JOIN tag_scope_map s ON s.old_id = a.source_tag_id
JOIN tag_scope_map t ON t.old_id = a.target_tag_id AND t.media_type = s.media_type
WHERE s.new_id <> s.old_id;
--> statement-breakpoint
INSERT INTO tag_merge (id, source_tag_id, target_tag_id, requested_by_user_id, created_at)
SELECT 'tagmerge_scope_album_' || md5(h.id), s.new_id, t.new_id, h.requested_by_user_id, h.created_at
FROM tag_scope_merge h JOIN tag_scope_map s ON s.old_id = h.source_tag_id
JOIN tag_scope_map t ON t.old_id = h.target_tag_id AND t.media_type = s.media_type
WHERE s.new_id <> s.old_id;
--> statement-breakpoint
ALTER TABLE "tag" ALTER COLUMN "media_type" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tag_identity" ALTER COLUMN "media_type" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "tag_media_type_name_kind_uidx" ON "tag" USING btree ("media_type", "name", "kind");
--> statement-breakpoint
ALTER TABLE "tag_identity" ADD CONSTRAINT "tag_identity_media_type_normalized_name_kind_pk" PRIMARY KEY("media_type", "normalized_name", "kind");
--> statement-breakpoint
-- Enforce isolation for direct SQL and writers outside the tag service too.
CREATE FUNCTION enforce_tag_media_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE left_scope media_type; right_scope media_type;
BEGIN
  IF TG_TABLE_NAME IN ('media_item_tag', 'tag_occurrence') THEN
    SELECT media_type INTO left_scope FROM media_item WHERE id = NEW.media_item_id FOR SHARE;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.tag_id;
  ELSIF TG_TABLE_NAME = 'tag_identity' THEN
    left_scope := NEW.media_type;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.tag_id;
  ELSE
    SELECT media_type INTO left_scope FROM tag WHERE id = NEW.source_tag_id;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.target_tag_id;
  END IF;
  IF left_scope IS DISTINCT FROM right_scope THEN
    RAISE EXCEPTION 'Tag media scope mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER media_item_tag_scope BEFORE INSERT OR UPDATE ON media_item_tag FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
--> statement-breakpoint
CREATE TRIGGER tag_occurrence_scope BEFORE INSERT OR UPDATE ON tag_occurrence FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
--> statement-breakpoint
CREATE TRIGGER tag_identity_scope BEFORE INSERT OR UPDATE ON tag_identity FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
--> statement-breakpoint
CREATE TRIGGER tag_alias_scope BEFORE INSERT OR UPDATE ON tag_alias FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
--> statement-breakpoint
CREATE TRIGGER tag_merge_scope BEFORE INSERT OR UPDATE ON tag_merge FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
--> statement-breakpoint
CREATE FUNCTION prevent_tag_scope_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.media_type IS DISTINCT FROM NEW.media_type THEN
    IF TG_TABLE_NAME = 'tag' THEN
      RAISE EXCEPTION 'Tag media scope is immutable' USING ERRCODE = '23514';
    ELSIF EXISTS (SELECT 1 FROM media_item_tag WHERE media_item_id = OLD.id)
       OR EXISTS (SELECT 1 FROM tag_occurrence WHERE media_item_id = OLD.id) THEN
      RAISE EXCEPTION 'Tagged media scope is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tag_immutable_scope BEFORE UPDATE OF media_type ON tag FOR EACH ROW EXECUTE FUNCTION prevent_tag_scope_change();
--> statement-breakpoint
CREATE TRIGGER media_item_tag_immutable_scope BEFORE UPDATE OF media_type ON media_item FOR EACH ROW EXECUTE FUNCTION prevent_tag_scope_change();

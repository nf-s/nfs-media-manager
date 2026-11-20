CREATE FUNCTION artist_profile_tag_keys(tags jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ARRAY(
    SELECT DISTINCT lower(btrim(regexp_replace(normalize(label, NFC), '[\s   -     　﻿]+', ' ', 'g'))) AS key
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS labels(label)
    WHERE label IS NOT NULL
    ORDER BY key
  );
$$;--> statement-breakpoint
CREATE INDEX "artist_provider_snapshot_tag_keys_idx" ON "artist_provider_snapshot" USING gin (artist_profile_tag_keys("normalized_data"->'tags'));--> statement-breakpoint
CREATE INDEX "media_item_recording_title_idx" ON "media_item" USING btree ("media_type",lower(trim(regexp_replace("title", '[[:space:]]+', ' ', 'g'))));--> statement-breakpoint
ANALYZE "media_item";--> statement-breakpoint
ANALYZE "artist_provider_snapshot";

CREATE OR REPLACE FUNCTION subscription_artist_name_keys(artists jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ARRAY(
    SELECT lower(btrim(label))
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(artists) = 'array' THEN artists ELSE '[]'::jsonb END
    ) AS billed(label)
    WHERE label IS NOT NULL
  );
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_item_artist_name_keys_idx" ON "subscription_item" USING gin (subscription_artist_name_keys("artists"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_source_exact_title_idx" ON "subscription_source" USING btree (lower(btrim("title"))) WHERE "subscription_source"."subscribed";

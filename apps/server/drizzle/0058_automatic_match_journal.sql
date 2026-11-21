-- Album history merges are made, and recorded, by the server.
DROP FUNCTION IF EXISTS merge_album_track_history(text);
--> statement-breakpoint
-- Album-only recordings inherit the album's credits with the name each
-- artist is credited as.
CREATE OR REPLACE FUNCTION resolve_album_library_tracks(album_id text, entries jsonb)
RETURNS TABLE (entry_id text, recording_id text)
LANGUAGE plpgsql AS $$
DECLARE
  entry record;
  album_title text;
  album_spotify_ids text[];
  chosen_id text;
  spotify_id text;
  title_key text;
  unique_title boolean;
BEGIN
  SELECT mi.title, array(
    SELECT external_id FROM provider_reference
      WHERE media_item_id = album_id AND (reference_type = 'spotify'
        OR (provider = 'spotify' AND reference_type = 'album'))
    UNION
    SELECT (regexp_match(al.spotify_url, '/album/([A-Za-z0-9]{22})([/?#]|$)'))[1]
  )
  INTO STRICT album_title, album_spotify_ids
  FROM album al JOIN media_item mi ON mi.id = al.media_item_id
  WHERE al.media_item_id = album_id;

  FOR entry IN
    SELECT item.*, count(*) OVER (PARTITION BY
      lower(regexp_replace(trim(item.title), '[[:space:]]+', ' ', 'g'))) AS title_count
    FROM jsonb_to_recordset(entries) AS item(id text, title text, position integer, external_id text)
    ORDER BY item.position
  LOOP
    chosen_id := NULL;
    spotify_id := CASE WHEN entry.external_id ~ '^[A-Za-z0-9]{22}$' THEN entry.external_id END;
    title_key := lower(regexp_replace(trim(entry.title), '[[:space:]]+', ' ', 'g'));
    unique_title := entry.title_count = 1;

    IF spotify_id IS NOT NULL THEN
      SELECT lt.media_item_id INTO chosen_id FROM library_track lt
      WHERE lt.spotify_track_id = spotify_id;
    END IF;

    IF chosen_id IS NULL THEN
      -- A repeated title can only reuse its unchanged, ID-less position.
      -- If the title becomes unambiguous, retain an existing recording on it.
      SELECT CASE WHEN count(DISTINCT old.track_media_item_id) = 1 THEN min(old.track_media_item_id) END
      INTO chosen_id
      FROM track old JOIN library_track lt ON lt.media_item_id = old.track_media_item_id
      WHERE old.album_media_item_id = album_id AND (
          (entry.external_id IS NOT NULL AND old.external_id = entry.external_id)
          OR (lower(regexp_replace(trim(old.title), '[[:space:]]+', ' ', 'g')) = title_key
            AND (unique_title OR (
              spotify_id IS NULL AND lt.spotify_track_id IS NULL AND old.position = entry.position
            )))
        )
        AND (old.external_id IS NULL OR entry.external_id IS NULL
          OR old.external_id = entry.external_id OR (spotify_id IS NOT NULL AND lt.spotify_track_id IS NULL))
        AND (lt.spotify_track_id IS NULL OR spotify_id IS NULL OR lt.spotify_track_id = spotify_id);
    END IF;

    IF chosen_id IS NULL AND unique_title AND title_key <> '' THEN
      -- Album and credited artist corroborate an exact title. Conflicting
      -- Spotify identities and ambiguous or artistless matches stay separate.
      SELECT CASE
        WHEN count(*) = 1 THEN min(lt.media_item_id)
          FILTER (WHERE lt.spotify_track_id IS NULL OR spotify_id IS NULL OR lt.spotify_track_id = spotify_id)
        WHEN spotify_id IS NULL AND count(*) FILTER (WHERE lt.spotify_track_id IS NOT NULL) = 1
          AND count(*) FILTER (WHERE mi.source_label IS DISTINCT FROM 'lastfm') = 1
          THEN min(lt.media_item_id) FILTER (WHERE lt.spotify_track_id IS NOT NULL)
        END INTO chosen_id
      FROM library_track lt JOIN media_item mi ON mi.id = lt.media_item_id
      WHERE (lt.album_media_item_id = album_id OR lt.spotify_album_id = ANY(album_spotify_ids)
          OR lt.album_name = album_title)
        AND mi.media_type = 'track'
        AND (lower(mi.title) = lower(entry.title) OR lt.album_media_item_id = album_id)
        AND lower(regexp_replace(trim(mi.title), '[[:space:]]+', ' ', 'g')) = title_key
        AND (lt.album_media_item_id IS NULL OR lt.album_media_item_id = album_id
          OR lt.spotify_album_id = ANY(album_spotify_ids))
        AND mi.metadata->>'legacyHidden' IS DISTINCT FROM 'true'
        AND EXISTS (
          SELECT 1 FROM media_credit ac JOIN media_credit rc ON rc.artist_id = ac.artist_id
          WHERE ac.media_item_id = album_id AND rc.media_item_id = mi.id
            AND ac.role = 'artist' AND rc.role = 'artist'
        );
    END IF;

    IF chosen_id IS NULL THEN
      chosen_id := 'library-track_' || left(md5(entry.id), 20);
      INSERT INTO media_item (id, media_type, slug, title, source_label)
      VALUES (chosen_id, 'track', chosen_id, entry.title, 'album')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO library_track (media_item_id, spotify_track_id, album_media_item_id, album_link_strategy)
      VALUES (chosen_id, spotify_id, album_id, 'album-track-list')
      ON CONFLICT (media_item_id) DO NOTHING;
    END IF;

    UPDATE library_track lt
    SET spotify_track_id = coalesce(lt.spotify_track_id, spotify_id),
      album_media_item_id = coalesce(lt.album_media_item_id, album_id),
      album_link_strategy = CASE WHEN lt.album_media_item_id IS NULL OR lt.album_media_item_id = album_id
        THEN 'album-track-list' ELSE lt.album_link_strategy END
    WHERE lt.media_item_id = chosen_id
      AND (lt.album_media_item_id IS NULL
        OR (lt.album_media_item_id = album_id AND lt.album_link_strategy IS DISTINCT FROM 'album-track-list')
        OR (lt.spotify_track_id IS NULL AND spotify_id IS NOT NULL));

    -- Imported tracks keep their credited artists. Album-only recordings can
    -- inherit album credits because the stored list has no track-level credits.
    INSERT INTO media_credit (media_item_id, artist_id, role, billing_order, credited_as)
    SELECT chosen_id, ac.artist_id, ac.role, ac.billing_order, ac.credited_as
    FROM media_credit ac
    WHERE ac.media_item_id = album_id AND ac.role = 'artist'
      AND NOT EXISTS (SELECT 1 FROM media_credit rc
        WHERE rc.media_item_id = chosen_id AND rc.role = 'artist')
    ON CONFLICT DO NOTHING;

    entry_id := entry.id;
    recording_id := chosen_id;
    RETURN NEXT;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Remembered matches of a scrobbled name go with the name.
CREATE FUNCTION forget_match_rejections()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM library_match_rejection r USING removed o
  WHERE r.username = o.username AND r.artist_key = o.artist_key
    AND r.track_key = o.track_key;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lastfm_track_source_forget_rejections
AFTER DELETE ON lastfm_track_source
REFERENCING OLD TABLE AS removed
FOR EACH STATEMENT EXECUTE FUNCTION forget_match_rejections();

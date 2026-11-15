SELECT pg_advisory_xact_lock(614105);
--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "track_media_item_id" text;
--> statement-breakpoint
CREATE INDEX "track_library_track_idx" ON "track" USING btree ("track_media_item_id");
--> statement-breakpoint

-- Reconcile stored and incoming lists with the same rules. The writer holds
-- the library-track advisory lock while resolving and replacing the list.
CREATE FUNCTION resolve_album_library_tracks(album_id text, entries jsonb)
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
    INSERT INTO media_credit (media_item_id, artist_id, role, billing_order)
    SELECT chosen_id, ac.artist_id, ac.role, ac.billing_order
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
-- A pre-existing Last.fm row may duplicate an exact Spotify match. Keep
-- all evidence when the scrobble group and the list select one recording.
CREATE FUNCTION merge_album_track_history(album_id text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT source.media_item_id AS source_id, min(t.track_media_item_id) AS target_id
    FROM library_track source
    JOIN media_item source_item ON source_item.id = source.media_item_id
    JOIN track t ON t.album_media_item_id = album_id
      AND lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g'))
        = lower(regexp_replace(trim(source_item.title), '[[:space:]]+', ' ', 'g'))
    WHERE source.album_media_item_id = album_id AND source.spotify_track_id IS NULL
      AND source_item.source_label = 'lastfm'
      AND NOT EXISTS (SELECT 1 FROM track listed WHERE listed.track_media_item_id = source.media_item_id)
      AND EXISTS (SELECT 1 FROM lastfm_track_source s WHERE s.track_media_item_id = source.media_item_id)
      AND NOT EXISTS (SELECT 1 FROM lastfm_track_source s
        WHERE s.track_media_item_id = source.media_item_id AND s.manually_matched)
      AND NOT EXISTS (SELECT 1 FROM library_track conflicting
        JOIN media_item m ON m.id = conflicting.media_item_id
        WHERE conflicting.album_media_item_id = album_id AND conflicting.spotify_track_id IS NOT NULL
          AND conflicting.media_item_id <> t.track_media_item_id
          AND lower(regexp_replace(trim(m.title), '[[:space:]]+', ' ', 'g'))
            = lower(regexp_replace(trim(source_item.title), '[[:space:]]+', ' ', 'g')))
    GROUP BY source.media_item_id
    HAVING count(DISTINCT t.track_media_item_id) = 1
       AND bool_or(EXISTS (SELECT 1 FROM media_credit sc
         JOIN media_credit tc ON tc.artist_id = sc.artist_id
         WHERE sc.media_item_id = source.media_item_id AND tc.media_item_id = t.track_media_item_id
           AND sc.role = 'artist' AND tc.role = 'artist'))
  LOOP
    INSERT INTO playlist_item (playlist_id, media_item_id, position, added_at)
    SELECT playlist_id, pair.target_id, position, added_at
    FROM playlist_item WHERE media_item_id = pair.source_id
    ON CONFLICT (playlist_id, media_item_id) DO UPDATE
      SET position = least(playlist_item.position, excluded.position),
        added_at = least(playlist_item.added_at, excluded.added_at);

    UPDATE lastfm_track_source SET track_media_item_id = pair.target_id
    WHERE track_media_item_id = pair.source_id;

    INSERT INTO lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    SELECT username, artist_key, track_key, pair.target_id, strategy
    FROM lastfm_track_link WHERE track_media_item_id = pair.source_id
    ON CONFLICT DO NOTHING;

    UPDATE library_track target
    SET date_added = least(target.date_added, source.date_added),
      scrobble_count = stats.total, last_listened_at = stats.last
    FROM library_track source, (
      SELECT count(*)::int AS total, max(s.listened_at) AS last
      FROM lastfm_track_link l
      JOIN lastfm_scrobble s USING (username, artist_key, track_key)
      WHERE l.track_media_item_id = pair.target_id
    ) stats
    WHERE target.media_item_id = pair.target_id AND source.media_item_id = pair.source_id;

    DELETE FROM media_item WHERE id = pair.source_id;
  END LOOP;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  stored record;
BEGIN
  FOR stored IN
    SELECT album_media_item_id, jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'external_id', external_id, 'position', position)) AS entries
    FROM track GROUP BY album_media_item_id ORDER BY album_media_item_id
  LOOP
    UPDATE track t
    SET track_media_item_id = resolved.recording_id
    FROM resolve_album_library_tracks(stored.album_media_item_id, stored.entries) resolved
    WHERE t.id = resolved.entry_id;
  END LOOP;
  PERFORM merge_album_track_history(a.media_item_id) FROM album a
  WHERE EXISTS (SELECT 1 FROM library_track lt JOIN media_item mi ON mi.id = lt.media_item_id
    WHERE lt.album_media_item_id = a.media_item_id AND lt.spotify_track_id IS NULL AND mi.source_label = 'lastfm');
END;
$$;
--> statement-breakpoint
ALTER TABLE "track" ALTER COLUMN "track_media_item_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "track" ADD CONSTRAINT "track_track_media_item_id_library_track_media_item_id_fk" FOREIGN KEY ("track_media_item_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;

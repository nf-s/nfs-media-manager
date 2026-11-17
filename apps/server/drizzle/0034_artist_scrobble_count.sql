ALTER TABLE "artist" ADD COLUMN "scrobble_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Every scrobble linked to a library album or library track credited to the
-- artist, counted once: the totals refreshArtistListeningTotals keeps. The
-- media type is compared as text because a new database adds the 'track' enum
-- value in this same transaction, where it cannot be used yet.
WITH plays AS MATERIALIZED (
  SELECT row_number() OVER () AS id, named.* FROM (
    SELECT username, artist_key, track_key, album_media_item_id, count(*)::int AS plays
    FROM lastfm_scrobble
    GROUP BY username, artist_key, track_key, album_media_item_id
  ) named
), credited AS MATERIALIZED (
  SELECT c.media_item_id, c.artist_id, m.media_type::text AS media_type
  FROM media_credit c JOIN media_item m ON m.id = c.media_item_id
  WHERE c.role = 'artist' AND m.media_type::text IN ('album', 'track')
    AND m.metadata->>'legacyHidden' IS DISTINCT FROM 'true'
), totals AS (
  SELECT artist_id, sum(plays)::int AS count FROM (
    SELECT credited.artist_id, plays.id, plays.plays
    FROM plays JOIN credited ON credited.media_item_id = plays.album_media_item_id
      AND credited.media_type = 'album'
    UNION
    SELECT credited.artist_id, plays.id, plays.plays
    FROM plays JOIN lastfm_track_link l ON l.username = plays.username
      AND l.artist_key = plays.artist_key AND l.track_key = plays.track_key
    JOIN credited ON credited.media_item_id = l.track_media_item_id
      AND credited.media_type = 'track'
  ) linked GROUP BY artist_id
)
UPDATE "artist" a SET "scrobble_count" = totals.count
FROM totals WHERE totals.artist_id = a.id;--> statement-breakpoint
CREATE INDEX "artist_browse_scrobbles_idx" ON "artist" USING btree ("scrobble_count" DESC NULLS LAST,"id");

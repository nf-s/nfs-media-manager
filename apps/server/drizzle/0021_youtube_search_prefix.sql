-- Custom SQL migration file, put your code below! --
-- Adds unstemmed words beside the English stems so a partial word matches the
-- start of a stored word. Must match searchVector in src/services/youtube-sync.ts.
WITH "source" AS (
  SELECT v.id, v.title, c.title AS channel_title, v.description,
    coalesce(
      (
        SELECT string_agg(item.tag, ' ' ORDER BY item.position)
        FROM jsonb_array_elements_text(v.tags) WITH ORDINALITY AS item(tag, position)
      ),
      ''
    ) AS tags
  FROM "youtube_video" AS v
  JOIN "youtube_channel" AS c ON c.id = v.channel_id
)
UPDATE "youtube_video"
SET "search" =
  setweight(to_tsvector('english', s.title), 'A') ||
  setweight(to_tsvector('english', s.channel_title || ' ' || s.tags), 'B') ||
  setweight(to_tsvector('english', s.description), 'D') ||
  setweight(to_tsvector('simple', s.title), 'A') ||
  setweight(to_tsvector('simple', s.channel_title || ' ' || s.tags), 'B') ||
  setweight(to_tsvector('simple', s.description), 'D')
FROM "source" AS s
WHERE "youtube_video".id = s.id;

import { sql, type SQL } from 'drizzle-orm'

const payload = sql`source.payload`
const normalized = sql`source.normalized_data`
const record = sql`native.record`
const serplyProvenance = sql`${normalized}->'mediaPatch'->'metadata'->'plugin.serply.provenance'`

function jsonArray(value: SQL) {
  return sql`case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end`
}

function stringValue(value: SQL) {
  return sql`case when jsonb_typeof(${value}) = 'string'
    then nullif(nullif(trim(${value} #>> '{}'), ''), 'N/A') end`
}

function arrayNames(values: SQL, name: SQL, condition = sql`true`) {
  return sql`(select string_agg(${name}, ', ' order by position)
    from jsonb_array_elements(${jsonArray(values)}) with ordinality as entry(value, position)
    where ${condition})`
}

const nativeRecord = sql`case source.provider
  when 'spotify' then coalesce(${payload}->'spotify', ${payload}->'album', ${payload})
  when 'lastfm' then coalesce(${payload}->'album', ${payload})
  when 'musicbrainz' then coalesce(${payload}->'releaseGroup', ${payload})
  when 'discogs' then coalesce(${payload}->'master', ${payload}->'release', ${payload}->'mainRelease', ${payload})
  else ${payload} end`

// An indexed search records its selected result URL. Join only that hit, never the
// first search result or the title/artist text sent to the provider.
const selectedSearchTitle = sql`(select ${stringValue(sql`result->'title'`)}
  from jsonb_array_elements(${jsonArray(sql`${payload}->'searches'`)}) with ordinality as search(value, position)
  cross join lateral jsonb_array_elements(${jsonArray(sql`search.value->'response'->'results'`)})
    with ordinality as hit(result, position)
  where result->>'link' = ${serplyProvenance}->>'sourceUrl'
  order by search.position, hit.position limit 1)`

const indexedTitle = sql`coalesce(
  ${stringValue(sql`${serplyProvenance}->'manualReference'->'sourceTitle'`)},
  ${selectedSearchTitle})`

const recordedTitle = sql`case source.provider
  when 'spotify' then ${stringValue(sql`${record}->'name'`)}
  when 'lastfm' then ${stringValue(sql`${record}->'name'`)}
  when 'musicbrainz' then ${stringValue(sql`${record}->'title'`)}
  when 'discogs' then ${stringValue(sql`${record}->'title'`)}
  when 'mdblist' then ${stringValue(sql`${record}->'title'`)}
  when 'omdb' then coalesce(${stringValue(sql`${record}->'Title'`)}, ${stringValue(sql`${record}->'title'`)})
  when 'tmdb' then ${stringValue(sql`${record}->'title'`)}
  when 'serply' then coalesce(
    ${stringValue(sql`${serplyProvenance}->'corroboratedIdentity'->'sourceTitle'`)},
    substring(indexed.title from '(?i)^(.+) by .+ - (?:RYM|Rate Your Music)$'),
    indexed.title)
  end`

const recordedCreator = sql`case source.provider
  when 'spotify' then ${arrayNames(sql`${record}->'artists'`, stringValue(sql`value->'name'`))}
  when 'discogs' then ${arrayNames(sql`${record}->'artists'`, stringValue(sql`value->'name'`))}
  when 'musicbrainz' then ${arrayNames(
    sql`${record}->'artist-credit'`,
    sql`coalesce(${stringValue(sql`value->'name'`)}, ${stringValue(sql`value->'artist'->'name'`)})`,
  )}
  when 'lastfm' then coalesce(${stringValue(sql`${record}->'artist'->'name'`)}, ${stringValue(sql`${record}->'artist'`)})
  when 'omdb' then coalesce(${stringValue(sql`${record}->'Director'`)}, ${stringValue(sql`${record}->'director'`)})
  when 'tmdb' then ${arrayNames(sql`${record}->'credits'->'crew'`, stringValue(sql`value->'name'`), sql`value->>'job' = 'Director'`)}
  when 'serply' then coalesce(
    ${stringValue(sql`${serplyProvenance}->'corroboratedIdentity'->'sourceArtist'`)},
    substring(indexed.title from '(?i)^.+ by (.+) - (?:RYM|Rate Your Music)$'))
  end`

const recordedIdentifier = sql`coalesce(
  (select ${stringValue(sql`value->'externalId'`)}
    from jsonb_array_elements(${jsonArray(sql`${normalized}->'references'`)}) with ordinality as item(value, position)
    where ${stringValue(sql`value->'externalId'`)} is not null and value->>'referenceType' is distinct from 'upc'
    order by (value->>'isPrimary' = 'true') desc nulls last, position limit 1),
  case source.provider
    when 'mdblist' then coalesce(${record}->'ids'->>'imdb', ${record}->>'imdb_id', ${record}->>'imdbid', ${record}->'ids'->>'tmdb', ${record}->>'tmdbid')
    when 'lastfm' then ${stringValue(sql`${record}->'url'`)}
  end)`

/** Projects display fields from the stored response, without returning payload or lookup inputs. */
export function mediaMatchEvidence(role: 'artist' | 'director') {
  return sql`
    select scope.id, source.provider,
      left(coalesce(${recordedTitle}, ${stringValue(sql`${normalized}->'mediaPatch'->'title'`)}), 1000) as name,
      left(coalesce(${recordedCreator}, ${arrayNames(
        sql`${normalized}->'credits'`,
        stringValue(sql`value->'name'`),
        sql`value->>'role' = ${role}`,
      )}), 1000) as creator,
      case when identity.value ~ '^[[:alnum:]_.:-]{1,200}$' then identity.value
        when length(identity.value) <= 500 and identity.value ~ '^https?://[[:alnum:]_.:-]+/[^?#[:space:]]+$' then identity.value
        end as identifier,
      null::text as artist_key, null::text as album_key, null::text as source_provider,
      null::integer as match_priority
    from evidence_scope scope
    join provider_current_state source on source.media_item_id = scope.id and source.status = 'ready'
    cross join lateral (select ${nativeRecord} as record) native
    cross join lateral (select case when source.provider = 'serply' then ${indexedTitle} end as title) indexed
    cross join lateral (select split_part(split_part(${recordedIdentifier}, '?', 1), '#', 1) as value) identity
    where source.provider not in ('legacy-record', 'legacy-browser', 'legacy-library', 'legacy-smart-playlists')`
}

export const legacyGoogleProvider = 'google-custom-search'
const rawMatch = sql`${payload}->site.raw_key`
const cleanedMatch = sql`${payload}->'links'->site.browse_key`
const legacyGooglePriority = sql`case source.provider
  when ${legacyGoogleProvider} then 0 when 'legacy-record' then 1 else 2 end`
const legacyRymUrl =
  '(?i)^https?://(?:www[.])?rateyourmusic[.]com/(?:release/[^/[:space:]]+/[^/[:space:]]+/[^/[:space:]]+(?:/(?:reviews|lists)(?:/[0-9]+)?)?|music-review/[^/[:space:]]+/[^/[:space:]]+/[^/[:space:]]+/[0-9]+)/?$'
const metacriticPathSegment = '(?!(?:[.]|%2e){1,2}(?:/|$))[^/[:space:]\\\\]+'
const legacyMetacriticUrl = `(?i)^https?://(?:www[.])?metacritic[.]com/music/${metacriticPathSegment}(?:/${metacriticPathSegment})*/?$`
const legacyTypedTitle =
  '(?i)^(?:Reviews of |Lists with )?(.+) by (.+) \\((?:Album|EP|Mixtape|Compilation|Single|DJ Mix)[,);]'
const legacyUntypedTitle = '(?i)^(.+) by (.+) - (?:RYM|Rate Your Music)$'
const legacyMetacriticTitle =
  '(?i)^(?:(?:Critic|User) Reviews for )?(.+) by (.+?)(?: Reviews and Tracks)? - Metacritic$'
const ambiguousMetacriticTitle = '(?i) by .+ by |[.]{3}|…'

/** Reads each selected Google result from the raw import or its cleaned browse row. */
export function legacyAlbumGoogleMatchEvidence() {
  return sql`
    union all
    select scope.id, ${legacyGoogleProvider}::text as provider,
      left(coalesce(header.parts[1], saved.title), 1000) as name,
      left(header.parts[2], 1000) as creator,
      saved.url as identifier,
      null::text as artist_key, null::text as album_key,
      saved.provider as source_provider, site.match_priority
    from evidence_scope scope
    cross join (values
      ('rymGoogle', 'rym', ${legacyRymUrl}::text, 0),
      ('metacriticGoogle', 'metacritic', ${legacyMetacriticUrl}::text, 1)
    ) site(raw_key, browse_key, url_pattern, match_priority)
    cross join lateral (
      select provider, title, url
      from (
        select source.provider, fields.title, fields.url, ${legacyGooglePriority} as priority,
          first_value(fields.url) over (order by ${legacyGooglePriority}) as selected_url
        from provider_current_state source
        cross join lateral (
          select case when source.provider = 'legacy-browser'
            then ${stringValue(sql`${cleanedMatch}->'title'`)}
            else ${stringValue(sql`${rawMatch}->'rawResponse'->'title'`)} end as title,
          split_part(split_part(case when source.provider = 'legacy-browser'
            then ${stringValue(sql`${cleanedMatch}->'href'`)}
            else ${stringValue(sql`${rawMatch}->'link'`)} end, '?', 1), '#', 1) as url
        ) fields
        where source.media_item_id = scope.id and source.status = 'ready'
          and source.provider in (${legacyGoogleProvider}, 'legacy-record', 'legacy-browser')
          and length(fields.url) <= 500 and fields.url ~ site.url_pattern
      ) candidates
      where url = selected_url
      order by (title is not null) desc, priority
      limit 1
    ) saved
    cross join lateral (
      select case
        when site.browse_key = 'rym' then coalesce(
          regexp_match(saved.title, ${legacyTypedTitle}),
          regexp_match(saved.title, ${legacyUntypedTitle})
        )
        when saved.title !~ ${ambiguousMetacriticTitle}
          then regexp_match(saved.title, ${legacyMetacriticTitle})
      end as parts
    ) header`
}

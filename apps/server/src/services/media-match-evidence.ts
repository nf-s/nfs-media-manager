import { sql, type SQL } from 'drizzle-orm'
import {
  albumMatchIdentifierMaxLength,
  albumTrackingQueryKeyPattern,
  legacyRymAlbumUrlMaxLength,
  legacyRymAlbumUrlPattern,
} from '@repo/schemas/provider-identification'

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

function objectValue(value: SQL) {
  return sql`case when jsonb_typeof(${value}) = 'object' then ${value} end`
}

function arrayNames(values: SQL, name: SQL, condition = sql`true`) {
  return sql`(select string_agg(${name}, ', ' order by position)
    from jsonb_array_elements(${jsonArray(values)}) with ordinality as entry(value, position)
    where ${condition})`
}

const discogsMaster = objectValue(sql`${payload}->'master'`)
const discogsRelease = objectValue(sql`${payload}->'release'`)
const discogsMainRelease = objectValue(sql`${payload}->'mainRelease'`)
const musicBrainzReleaseGroup = objectValue(sql`${payload}->'releaseGroup'`)
const nativeRecord = sql`case source.provider
  when 'spotify' then coalesce(${payload}->'spotify', ${payload}->'album', ${payload})
  when 'lastfm' then coalesce(${objectValue(sql`${payload}->'album'`)}, ${payload})
  when 'musicbrainz' then coalesce(${musicBrainzReleaseGroup}, ${payload})
  when 'discogs' then coalesce(${discogsMaster}, ${discogsRelease}, ${discogsMainRelease}, ${payload})
  when 'metacritic' then ${payload}->'replacement'
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
  when 'metacritic' then ${stringValue(sql`${record}->'title'`)}
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
  when 'metacritic' then ${stringValue(sql`${record}->'artist'`)}
  when 'omdb' then coalesce(${stringValue(sql`${record}->'Director'`)}, ${stringValue(sql`${record}->'director'`)})
  when 'tmdb' then ${arrayNames(sql`${record}->'credits'->'crew'`, stringValue(sql`value->'name'`), sql`value->>'job' = 'Director'`)}
  when 'serply' then coalesce(
    ${stringValue(sql`${serplyProvenance}->'corroboratedIdentity'->'sourceArtist'`)},
    substring(indexed.title from '(?i)^.+ by (.+) - (?:RYM|Rate Your Music)$'))
  end`

const normalizedReference = sql`select
    ${stringValue(sql`value->'externalId'`)} as identifier,
    ${stringValue(sql`value->'referenceType'`)} as reference_type
  from jsonb_array_elements(${jsonArray(sql`${normalized}->'references'`)}) with ordinality as item(value, position)
  where ${stringValue(sql`value->'externalId'`)} is not null and value->>'referenceType' is distinct from 'upc'
  order by (value->>'isPrimary' = 'true') desc nulls last, position limit 1`

// The wrapper that supplied the displayed record determines its namespace.
// In a Discogs master response, the main release is separate evidence.
const discogsReferenceType = sql`case
    when ${discogsMaster} is not null then 'master'
    when coalesce(${discogsRelease}, ${discogsMainRelease}) is not null then 'release'
  end`
const nativeId = sql`${record}->>'id'`
const musicBrainzId = stringValue(sql`${record}->'id'`)
const publicPathSegment = '(?!(?:[.]|%2e){1,2}(?:/|$))[^/[:space:]\\\\]+'
const lastFmAlbumPath = `(?i)^https?://(?:www[.])?last[.]fm/music/(?:[+]noredirect/)?${publicPathSegment}/${publicPathSegment}/?$`

const nativeIdentifier = sql`case source.provider
    when 'discogs' then case
      when ${discogsReferenceType} is not null and ${nativeId} ~ '^[1-9][0-9]{0,15}$'
      then case when (${nativeId})::numeric <= 9007199254740991 then ${nativeId} end
    end
    when 'musicbrainz' then case
      when ${musicBrainzReleaseGroup} is not null and ${musicBrainzId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then lower(${musicBrainzId})
    end
    when 'mdblist' then coalesce(${record}->'ids'->>'imdb', ${record}->>'imdb_id', ${record}->>'imdbid', ${record}->'ids'->>'tmdb', ${record}->>'tmdbid')
    when 'lastfm' then ${stringValue(sql`${record}->'url'`)}
  end`

const nativeReferenceType = sql`case source.provider
    when 'discogs' then ${discogsReferenceType}
    when 'musicbrainz' then 'release-group'
    when 'lastfm' then case when identity.value ~ ${lastFmAlbumPath} then 'url' end
  end`

const recordedIdentifier = sql`coalesce(reference.identifier, ${nativeIdentifier})`

/** Projects display fields from the stored response, without returning payload or lookup inputs. */
export function mediaMatchEvidence(role: 'artist' | 'director') {
  const catalogAlbum =
    role === 'artist'
      ? sql`case when reference.reference_type not in ('upc', 'ean')
          and jsonb_typeof(${payload}->'id') in ('string', 'number')
          and ${payload}->>'id' = reference.identifier
          and jsonb_typeof(${payload}->'artists') = 'array'
          then ${payload} end`
      : sql`null::jsonb`
  return sql`
    select scope.id, source.provider,
      left(coalesce(${recordedTitle}, ${stringValue(sql`${normalized}->'mediaPatch'->'title'`)},
        ${stringValue(sql`catalog.album->'title'`)}), 1000) as name,
      left(coalesce(${recordedCreator}, ${arrayNames(
        sql`${normalized}->'credits'`,
        stringValue(sql`value->'name'`),
        sql`value->>'role' = ${role}`,
      )}, ${arrayNames(
        sql`catalog.album->'artists'`,
        sql`coalesce(${stringValue(sql`value->'name'`)}, ${stringValue(sql`value`)})`,
      )}), 1000) as creator,
      case when identity.value ~ '^[[:alnum:]_.:-]{1,200}$' then identity.value
        when length(identity.value) <= 500 and identity.value ~ '^https?://[[:alnum:]_.:-]+/[^?#[:space:]]+$' then identity.value
        end as identifier,
      null::text as artist_key, null::text as album_key, null::text as source_provider,
      null::integer as match_priority, source.latest_snapshot_id as snapshot_id,
      case when reference.reference_type is distinct from 'ean'
        and (${recordedIdentifier} !~ '[?#]'
          or (source.provider = 'lastfm' and identity.value ~ ${lastFmAlbumPath})
          or (source.provider in ('serply', ${legacyGoogleProvider}) and identity.value ~ ${legacyRymUrl})
          or (source.provider = ${legacyGoogleProvider} and identity.value ~ ${legacyMetacriticUrl}))
        then case when reference.identifier is not null then reference.reference_type else ${nativeReferenceType} end
      end as reference_type
    from evidence_scope scope
    join provider_current_state source on source.media_item_id = scope.id and source.status = 'ready'
    cross join lateral (select ${nativeRecord} as record) native
    cross join lateral (select case when source.provider = 'serply' then ${indexedTitle} end as title) indexed
    left join lateral (${normalizedReference}) reference on true
    cross join lateral (select ${catalogAlbum} as album) catalog
    cross join lateral (select split_part(split_part(${recordedIdentifier}, '?', 1), '#', 1) as value) identity
    where source.provider not in ('legacy-record', 'legacy-browser', 'legacy-library', 'legacy-smart-playlists')`
}

export const legacyGoogleProvider = 'google-custom-search'
const rawMatch = sql`${payload}->site.raw_key`
const cleanedMatch = sql`${payload}->'links'->browse.key`
const legacyGooglePriority = sql`case source.provider
  when ${legacyGoogleProvider} then 0 when 'legacy-record' then 1 else 2 end`
const legacyRymUrl =
  '(?i)^https?://(?:www[.])?rateyourmusic[.]com/(?:release/[^/[:space:]]+/[^/[:space:]]+/[^/[:space:]]+(?:/(?:reviews|lists)(?:/[0-9]+)?)?|music-review/[^/[:space:]]+/[^/[:space:]]+/[^/[:space:]]+/[0-9]+)/?$'
const legacyMetacriticUrl = `(?i)^https?://(?:www[.])?metacritic[.]com/music/${publicPathSegment}(?:/${publicPathSegment})*/?$`
const asciiCharacters = String.raw`[\u0001-\u007f]`
const rymTrackingQuery = `(?:${albumTrackingQueryKeyPattern})(?:=[^&#]*)?`
const rymNoIdentityQuery = String.raw`(?i)^[^?]+(?:\?(?:${rymTrackingQuery}(?:&${rymTrackingQuery})*)?)?$`

function encodedUrlLength(value: SQL) {
  // A non-ASCII UTF-8 byte becomes three characters in a percent-encoded URL.
  return sql`case when length(${value}) = octet_length(${value}) then length(${value})
    else (octet_length(${value}) + 2 * octet_length(regexp_replace(${value}, ${asciiCharacters}, '', 'g'))) end`
}

const legacyTypedTitle =
  '(?i)^(?:Reviews of |Lists with )?(.+) by (.+) \\((?:Album|EP|Mixtape|Compilation|Single|DJ Mix)[,);]'
const legacyRymSuffix = ' - (?:RYM(?:/Sonemic)?|Rate Your Music)$'
const legacyUntypedTitle = '(?i)^(.+) by (.+)' + legacyRymSuffix
const legacyMetacriticTitle =
  '(?i)^(?:(?:Critic|User) Reviews for )?(.+) by (.+?)(?: Reviews and Tracks)? - Metacritic$'
const ambiguousPageTitle = '(?i) by .+ by |[.]{3}|…'

function rymTitleParts(title: SQL) {
  return sql`coalesce(regexp_match(${title}, ${legacyTypedTitle}), regexp_match(${title}, ${legacyUntypedTitle}))`
}

/** Use the structured album and artist to resolve literal ellipses or a second "by" in the heading. */
function archivedRymPageParts(pageMap: SQL) {
  const albumEntities = sql`${pageMap}->'musicalbum'`
  const artistEntities = sql`${pageMap}->'musicgroup'`
  const truncatedEnd = '([.]{3}|…)$'
  return sql`(select case
    when page.title !~ ${ambiguousPageTitle} then ${rymTitleParts(sql`page.title`)}
    when page.title ~* ${legacyRymSuffix}
      and jsonb_array_length(${jsonArray(albumEntities)}) = 1
      and jsonb_array_length(${jsonArray(artistEntities)}) = 1
      and page.album !~ ${truncatedEnd} and credited.heading !~ ${truncatedEnd}
      and (credited.heading = page.album || ' by ' || page.artist
        or starts_with(credited.heading, page.album || ' by ' || page.artist || ' / '))
      then array[page.album, substr(credited.heading, length(page.album) + 5)]
    end
    from (values (
      ${stringValue(sql`${pageMap} #> '{metatags,0,og:title}'`)},
      ${stringValue(sql`${albumEntities} #> '{0,name}'`)},
      ${stringValue(sql`${artistEntities} #> '{0,name}'`)}
    )) page(title, album, artist)
    cross join lateral (select trim(regexp_replace(page.title, ${legacyRymSuffix}, '', 'i')) as heading) credited)`
}

/** Reads each selected Google result from the raw import or its cleaned browse row. */
export function legacyAlbumGoogleMatchEvidence() {
  return sql`
    union all
    select scope.id, ${legacyGoogleProvider}::text as provider,
      left(coalesce(header.parts[1], saved.title), 1000) as name,
      left(header.parts[2], 1000) as creator,
      saved.url as identifier,
      null::text as artist_key, null::text as album_key,
      saved.provider as source_provider, site.match_priority,
      saved.latest_snapshot_id as snapshot_id, site.reference_type
    from evidence_scope scope
    cross join (values
      ('rymGoogle', 'rym', null, ${legacyRymUrl}::text, 0, 'rym-url'),
      ('metacriticGoogle', 'metacritic', 'mc', ${legacyMetacriticUrl}::text, 1, 'metacritic-url')
    ) site(raw_key, browse_key, fallback_key, url_pattern, match_priority, reference_type)
    cross join lateral (
      select provider, latest_snapshot_id, title, page_parts, url
      from (
        select source.provider, source.latest_snapshot_id, fields.title, fields.page_parts, selected.url,
          ${legacyGooglePriority} as priority, fields.key_priority,
          first_value(selected.url) over (order by ${legacyGooglePriority}, fields.key_priority) as selected_url
        from provider_current_state source
        cross join lateral (
          select case when source.provider = 'legacy-browser'
            then ${stringValue(sql`${cleanedMatch}->'title'`)}
            else ${stringValue(sql`${rawMatch}->'rawResponse'->'title'`)} end as title,
          case when site.browse_key = 'rym'
            and ${rawMatch}->'rawResponse'->>'link' = ${rawMatch}->>'link'
            and jsonb_array_length(${jsonArray(sql`${rawMatch} #> '{rawResponse,pagemap,metatags}'`)}) = 1
            then ${archivedRymPageParts(sql`${rawMatch} #> '{rawResponse,pagemap}'`)}
          end as page_parts,
          case when source.provider = 'legacy-browser'
            then ${stringValue(sql`${cleanedMatch}->'href'`)}
            else ${stringValue(sql`${rawMatch}->'link'`)} end as raw_url,
            browse.position as key_priority
          from unnest(array[site.browse_key, site.fallback_key]) with ordinality as browse(key, position)
          where browse.key is not null
            and (source.provider = 'legacy-browser' or browse.position = 1)
        ) fields
        cross join lateral (
          select split_part(split_part(fields.raw_url, '#', 1), '?', 1) as url
        ) selected
        where source.media_item_id = scope.id and source.status = 'ready'
          and source.provider in (${legacyGoogleProvider}, 'legacy-record', 'legacy-browser')
          and selected.url ~ site.url_pattern
          and (
            case when site.reference_type = 'rym-url' then
              ${encodedUrlLength(sql`selected.url`)} <= ${albumMatchIdentifierMaxLength} or (
                ${encodedUrlLength(sql`selected.url`)} <= ${legacyRymAlbumUrlMaxLength}
                and selected.url ~ ${`(?i)${legacyRymAlbumUrlPattern}`}
                and split_part(fields.raw_url, '#', 1) ~ ${rymNoIdentityQuery}
              )
            else length(selected.url) <= ${albumMatchIdentifierMaxLength} end
          )
      ) candidates
      where url = selected_url
      order by (title is not null) desc, (title is null and page_parts is not null) desc, priority, key_priority
      limit 1
    ) saved
    cross join lateral (
      select case
        when site.browse_key = 'rym' then coalesce(
          ${rymTitleParts(sql`saved.title`)},
          saved.page_parts
        )
        when saved.title !~ ${ambiguousPageTitle}
          then regexp_match(saved.title, ${legacyMetacriticTitle})
      end as parts
    ) header`
}

/** Keeps the selected legacy release evidence ahead of duplicate summary rows. */
export function visibleMediaMatches(kind: 'album' | 'film') {
  return sql`select * from evidence match
    where (name is not null or creator is not null or identifier is not null)
    ${
      kind === 'album'
        ? sql`and not (match.provider = ${legacyGoogleProvider} and match.match_priority is null
          and exists (select 1 from evidence saved where saved.id = match.id
            and saved.provider = match.provider and saved.match_priority is not null
            and (match.identifier = saved.identifier or (match.identifier is null
              and (match.name is null or match.name = saved.name)
              and (match.creator is null or match.creator = saved.creator)))))`
        : sql.empty()
    }`
}

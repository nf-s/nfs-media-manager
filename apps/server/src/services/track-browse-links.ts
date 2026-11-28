import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import { tidalSharingUrl } from '@/lib/tidal-api'

const services = {
  spotify: {
    label: 'Spotify',
    url: (target: string) => `https://open.spotify.com/track/${target}`,
  },
  tidal: {
    label: 'TIDAL',
    url: (target: string) => tidalSharingUrl('track', target),
  },
  musicbrainz: {
    label: 'MusicBrainz',
    url: (target: string) => `https://musicbrainz.org/recording/${target}`,
  },
  lastfm: {
    label: 'Last.fm',
    url: (target: string) => `https://www.last.fm${target}`,
  },
}
const LinkProviderSchema = z.enum(['spotify', 'tidal', 'musicbrainz', 'lastfm'])
const musicBrainzRecordingId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const tidalTrackId = /^\d{1,20}$/
const lastfmTrackPath =
  /^https?:\/\/(?:www\.)?last\.fm(\/music\/[^/?#\s]+\/_\/[^/?#\s]+)(?:[?#].*)?$/i
const lastfmTrackPattern = `(?i)${lastfmTrackPath.source}`

export const TrackBrowseLinkTargetsSchema = z
  .array(z.object({ provider: LinkProviderSchema, target: z.string() }))
  .nullable()

/** Read at most one usable track identity per selected service during page hydration. */
export function trackBrowseLinkTargets(id: SQL, providers: readonly string[]) {
  const selected = providers.filter(
    (provider) => LinkProviderSchema.safeParse(provider).success,
  )
  if (!selected.length) return sql`null::jsonb`
  return sql`coalesce((
    select jsonb_agg(jsonb_build_object('provider', provider, 'target', target) order by provider)
    from (
      select distinct on (provider) provider, target
      from (
        select lower(r.provider) as provider, r.id, r.updated_at, r.is_primary,
          case
            when lower(r.provider) = 'spotify' and r.reference_type in ('track', 'spotify-track', 'spotify_track')
              and r.external_id ~ ${spotifyIdPattern.source} then r.external_id
            when lower(r.provider) = 'tidal' and r.reference_type = 'track'
              and r.external_id ~ ${tidalTrackId.source} then r.external_id
            when lower(r.provider) = 'musicbrainz' and r.reference_type = 'recording'
              and r.external_id ~* ${musicBrainzRecordingId.source} then r.external_id
            when lower(r.provider) = 'lastfm' and r.reference_type in ('track-url', 'recording-mbid')
              then coalesce(
                substring(r.metadata->>'url' from ${lastfmTrackPattern}),
                substring(r.external_id from ${lastfmTrackPattern})
              )
          end as target
        from provider_reference r
        where r.media_item_id = ${id} and lower(r.provider) = any(${sql.param(selected)}::text[])
          and r.metadata->>'rejected' is distinct from 'true'
          and r.metadata->>'verified' is distinct from 'false'
      ) references_with_targets
      where target is not null
      order by provider, is_primary desc, updated_at desc, id
    ) targets
  ), '[]'::jsonb)`
}

export function trackBrowseLinks(
  providers: readonly string[],
  targets: z.infer<typeof TrackBrowseLinkTargetsSchema>,
  spotifyTrackId: string | null,
) {
  if (targets === null) return undefined
  const nativeTargets = new Map(
    targets.map(({ provider, target }) => [provider, target]),
  )
  if (
    providers.includes('spotify') &&
    spotifyTrackId &&
    spotifyIdPattern.test(spotifyTrackId)
  )
    nativeTargets.set('spotify', spotifyTrackId)
  return [...nativeTargets].map(([provider, target]) => ({
    provider,
    label: services[provider].label,
    url: services[provider].url(target),
  }))
}

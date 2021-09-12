import { AlbumId, albumTitle, library } from ".";

export interface CleanAlbum {
  id: AlbumId;
  spotifyId: string;
  title: string;
  artist: string;
  durationSec: number;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  tracks: string[];
  art: string | undefined;
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  mode: number;
  speechiness: number;
  tempo: number;
  valence: number;
  ratingRymVotes?: number;
  ratingRymValue?: number;
  ratingDiscogsVotes?: number;
  ratingDiscogsValue?: number;
  ratingMetacriticVotes?: number;
  ratingMetacriticValue?: number;
  popularityDiscogs?: number;
  popularitySpotify?: number;
  popularityLastFm?: number;
  scrobbles?: number;
  links: {
    spotify: string;
    rym?: string;
    discogs?: string;
    lastfm?: string;
    mb?: string;
    mc?: string;
  };
  otherTitles: {
    rym?: string;
    discogs?: string;
    lastfm?: string;
    mb?: string;
    csv?: string;
    mc?: string;
  };
}

export type CleanLibrary = CleanAlbum[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.albums)
    .map((album) => {
      try {
        let lastFmTags = album.lastFm?.tags?.tag ?? [];
        lastFmTags = Array.isArray(lastFmTags) ? lastFmTags : [lastFmTags];

        const discogsGenres = [];
        const discogsStyles = [];
        let discogsRating = { votes: 0, value: 0 };
        let discogsPopularity = 0;

        if (album.discogs) {
          if ("master" in album.discogs) {
            if (album.discogs.master && "genres" in album.discogs.master) {
              discogsGenres.push(...album.discogs.master.genres);
            }

            if (album.discogs.master && "styles" in album.discogs.master) {
              discogsStyles.push(...album.discogs.master.styles);
            }

            if (album.discogs.releasesWithRatings) {
              discogsRating = album.discogs.releasesWithRatings.reduce<{
                votes: number;
                value: number;
              }>(
                (rating, release) => {
                  rating.value +=
                    release.ratings.rating.average *
                    release.ratings.rating.count;
                  rating.votes += release.ratings.rating.count;
                  return rating;
                },
                { votes: 0, value: 0 }
              );

              discogsRating.value =
                discogsRating.value / (discogsRating.votes || 1);

              if (album.discogs.releases) {
                discogsPopularity = album.discogs.releases.reduce<number>(
                  (pop, release) =>
                    pop +
                    release.stats.community.in_collection +
                    release.stats.community.in_wantlist,
                  0
                );
              }
            }
          } else {
            discogsGenres.push(...(album.discogs.release.genres ?? []));
            discogsStyles.push(...(album.discogs.release.styles ?? []));

            if (album.discogs.release.community.rating) {
              discogsPopularity =
                album.discogs.release.community.have +
                album.discogs.release.community.want;

              discogsRating.value =
                album.discogs.release.community.rating.average;
              discogsRating.votes =
                album.discogs.release.community.rating.count;
            }
          }
        }

        const genres = [
          ...(album.rymGoogle?.genres ?? []),
          ...discogsGenres,
          ...discogsStyles,
          ...(!album.id.discogs
            ? (album.mb?.releaseGroup as any)?.genres?.map(
                (g: any) => g.name
              ) ?? []
            : []),
          ...lastFmTags.map((t) => t.name),
        ].map((g) => (g as string).toLowerCase());

        // Only use addedDate if it occurs after the release date
        const dateAdded =
          new Date(album.spotify.addedDate) >
          new Date(album.spotify.release_date)
            ? album.spotify.addedDate
            : album.spotify.release_date;

        const cleanAlbum: CleanAlbum = {
          id: album.id,
          spotifyId: album.id.spotify,
          title: album.spotify.name,
          artist: album.spotify.artists.map((artist) => artist.name).join(", "),
          durationSec: album.spotify.tracks.items.reduce<number>(
            (sec, track) => sec + track.duration_ms / 1000,
            0
          ),
          dateReleased: album.spotify.release_date,
          dateAdded,
          genres: Array.from(new Set(genres)),
          tracks: album.spotify.tracks.items.map((track) => track.id),
          art: album.spotify.images.find((i) => i.height === 300)?.url,
          ratingRymValue: album.rymGoogle?.rating.average,
          ratingRymVotes: album.rymGoogle?.rating.count,
          ratingDiscogsValue: discogsRating?.value,
          ratingDiscogsVotes: discogsRating?.votes,
          ratingMetacriticValue: album.metacriticGoogle?.rating.average,
          ratingMetacriticVotes: album.metacriticGoogle?.rating.count,
          popularityDiscogs: discogsPopularity,
          popularitySpotify: album.spotify.popularity,
          popularityLastFm: album.lastFm?.listeners
            ? parseInt(album.lastFm?.listeners, 10)
            : undefined,
          acousticness: mean(
            album.spotify.audioFeatures.map((a) => a.acousticness)
          ),
          danceability: mean(
            album.spotify.audioFeatures.map((a) => a.danceability)
          ),
          energy: mean(album.spotify.audioFeatures.map((a) => a.energy)),
          instrumentalness: mean(
            album.spotify.audioFeatures.map((a) => a.instrumentalness)
          ),
          liveness: mean(album.spotify.audioFeatures.map((a) => a.liveness)),
          loudness: mean(album.spotify.audioFeatures.map((a) => a.loudness)),
          mode: mean(album.spotify.audioFeatures.map((a) => a.mode)),
          speechiness: mean(
            album.spotify.audioFeatures.map((a) => a.speechiness)
          ),
          tempo: mean(album.spotify.audioFeatures.map((a) => a.tempo)),
          valence: mean(album.spotify.audioFeatures.map((a) => a.valence)),
          scrobbles: album.lastFm?.userplaycount
            ? parseInt(album.lastFm?.userplaycount, 10)
            : undefined,
          links: {
            rym: album.rymGoogle?.link,
            lastfm: album.lastFm?.url,
            mb: album.mb?.releaseGroup.id
              ? `https://musicbrainz.org/release-group/${album.mb?.releaseGroup.id}`
              : undefined,
            discogs: album.discogs
              ? "master" in album.discogs
                ? album.discogs.master.uri
                : album.discogs.release.uri
              : undefined,
            spotify: album.spotify.external_urls.spotify,
            mc: album.metacriticGoogle?.link,
          },
          otherTitles: {
            csv:
              album.source && album.source.type !== "spotify"
                ? `${album.source.title} by ${album.source.artist}`
                : undefined,
            rym: album.rymGoogle?.rawResponse?.title,
            lastfm: `${album.lastFm?.name} by ${album.lastFm?.artist?.name}`,
            mb: `${album.mb?.releaseGroup.title}`,
            discogs: album.discogs
              ? "master" in album.discogs
                ? `${
                    album.discogs.master.title
                  } by ${album.discogs.master.artists
                    .map((a) => a.name)
                    .join(", ")}`
                : `${
                    album.discogs.release.title
                  } by ${album.discogs.release.artists
                    .map((a) => a.name)
                    .join(", ")}`
              : undefined,
            mc: album.metacriticGoogle?.rawResponse?.title,
          },
        };

        return cleanAlbum;
      } catch (error) {
        console.error(`FAILED to clean album ${albumTitle(album)}`);
        console.error(error);
      }
    })
    .filter((album) => typeof album !== "undefined") as CleanLibrary;
}

const mean = (nums: number[]) =>
  nums.length === 0 ? 0 : nums.reduce((sum, num) => sum + num, 0) / nums.length;

import { albumTitle, isAlbumPlaylist, library } from ".";
import { CleanAlbum, CleanAlbumPlaylist, CleanLibrary } from "./interfaces";

export async function clean(): Promise<CleanLibrary> {
  const playlists: { [id: string]: CleanAlbumPlaylist } = {};

  Object.values(library.playlists).forEach((playlist) => {
    if (isAlbumPlaylist(playlist)) {
      const p: CleanAlbumPlaylist = {
        id: playlist.id,
        name: playlist.name,
        albums: playlist.albums.map((album) =>
          typeof album === "string"
            ? album
            : {
                spotifyId: album.id,
                title: album.name,
                artists: album.artists.map((a) => a.name),
                dateReleased: new Date(album.release_date).getTime(),
                art: album.images.find((i) => i.height === 300)?.url,
              }
        ),
      };

      playlists[p.id] = p;
    }
  });

  const albums: { [id: string]: CleanAlbum } = {};

  Object.values(library.albums).forEach((album) => {
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
                  release.ratings.rating.average * release.ratings.rating.count;
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
            discogsRating.votes = album.discogs.release.community.rating.count;
          }
        }
      }

      const genres = [
        ...album.spotify.artists
          .map((a) => library.artists[a.id])
          .filter((a) => a)
          .map((a) => a.spotify.genres)
          .flat(),
        ...(album.rymGoogle?.genres ?? []),
        ...discogsGenres,
        ...discogsStyles,
        ...(!album.id.discogs
          ? (album.mb?.releaseGroup as any)?.genres?.map((g: any) => g.name) ??
            []
          : []),
        ...lastFmTags.map((t) => t.name),
      ].map((g) => (g as string).toLowerCase());

      // Only use addedDate if it occurs after the release date
      const dateAdded =
        new Date(album.spotify.addedDate) > new Date(album.spotify.release_date)
          ? album.spotify.addedDate
          : album.spotify.release_date;

      const cleanAlbum: CleanAlbum = {
        id: album.id,
        spotifyId: album.id.spotify,
        title: album.spotify.name,
        artists: album.spotify.artists.map((artist) => artist.name),
        durationSec: album.spotify.tracks.items.reduce<number>(
          (sec, track) => sec + track.duration_ms / 1000,
          0
        ),
        dateReleased: new Date(album.spotify.release_date).getTime(),
        dateAdded: new Date(dateAdded).getTime(),
        genres: Array.from(new Set(genres)),
        playlists: album.playlists,
        tracks: album.spotify.tracks.items.map((track) => track.id),
        countries:
          (album.mb?.releaseGroup["artist-credit"]
            ?.map((a) => a.artist.country)
            .filter((c) => typeof c === "string") as string[]) ?? [],
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
              ? `${album.discogs.master.title} by ${album.discogs.master.artists
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

      albums[cleanAlbum.spotifyId] = cleanAlbum;
    } catch (error) {
      console.error(`FAILED to clean album ${albumTitle(album)}`);
      console.error(error);
    }
  });

  return { albums, playlists };
}

const mean = (nums: number[]) =>
  nums.length === 0 ? 0 : nums.reduce((sum, num) => sum + num, 0) / nums.length;

import { albumTitle, isAlbumPlaylist, library } from "../index.js";
import { CleanAlbum, CleanAlbumPlaylist, CleanLibrary } from "data-types";

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

      const countries = new Set<string>();

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

      // Order is important here, as we want to prioritize the genres from RYM and then Spotify artist
      const genres = [
        ...(album.rymGoogle?.genres ?? []),
        ...album.spotify.artists
          .map((a) => library.artists[a.id])
          .filter((a) => a)
          .map((a) => a.spotify.genres)
          .flat(),
        ...lastFmTags.map((t) => t.name),
        ...discogsGenres,
        ...discogsStyles,
        ...(!album.id.discogs
          ? (album.mb?.releaseGroup as any)?.genres?.map((g: any) => g.name) ??
            []
          : []),
      ].map((g) => (g as string).toLowerCase());

      // Only use addedDate if it occurs after the release date
      const dateAdded =
        new Date(album.spotify.addedDate) > new Date(album.spotify.release_date)
          ? album.spotify.addedDate
          : album.spotify.release_date;

      album.mb?.releaseGroup["artist-credit"]?.forEach((a) => {
        if (typeof a.artist.country === "string") {
          countries.add(a.artist.country);
        }
      });

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
        countries: Array.from(countries),
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
          rym: {
            href: album.rymGoogle?.link,
            title: album.rymGoogle?.rawResponse?.title,
          },
          lastfm: {
            href: album.lastFm?.url,
            title: `${album.lastFm?.name} by ${album.lastFm?.artist?.name}`,
          },
          mb: {
            href: album.mb?.releaseGroup.id
              ? `https://musicbrainz.org/release-group/${album.mb?.releaseGroup.id}`
              : undefined,
            title: `${album.mb?.releaseGroup.title}`,
          },
          discogs: {
            href: album.discogs
              ? "master" in album.discogs
                ? album.discogs.master.uri
                : album.discogs.release.uri
              : undefined,
            title: album.discogs
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
          },
          spotify: {
            href: album.spotify.external_urls.spotify,
            title: albumTitle(album),
          },
          mc: {
            href: album.metacriticGoogle?.link,
            title: album.metacriticGoogle?.rawResponse?.title,
          },
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

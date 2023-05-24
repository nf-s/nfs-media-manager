import { debug as debugInit } from "debug";
import SpotifyWebApi from "spotify-web-api-node";
import { Album, isAlbumPlaylist, library } from "..";
import { getArtists, getAudioFeatures, spotifyLimiter } from "./spotify";

const debug = debugInit("music-scraper:spotify-playlist");

export interface SpotifyPlaylistTrack extends SpotifyApi.PlaylistTrackObject {
  audioFeatures?: SpotifyApi.AudioFeaturesObject;
  artists?: SpotifyApi.ArtistObjectFull[];
}

export async function scrapeSpotifyTrackPlaylists() {
  const trackPlaylists: string[] = []; /*["4VZp1yvv27nEcEJXG3dVYb"]; */
  // EF-all 6H6tTq8Is6D2X8PZi5rJmK

  for (const id of trackPlaylists) {
    if (library.playlists[id]) return;

    debug(`Scraping track playlist ${id}`);

    const playlist = await getPlaylist(id);
    const tracks = await getPlaylistTracksWithMetadata(id);

    if (playlist && tracks) {
      debug(`Saving track playlist ${playlist.name}`);
      library.playlists[id] = {
        ...playlist,
        tracks,
        chart: false,
        ascending: true,
      };
    } else {
      debug(`FAILED to fetch tracks playlist ${id}`);
    }
  }
}

export async function scrapeSpotifyAlbumPlaylists() {
  const chartPlaylists = ["7emRnrvtROcn2YgsKdHlPc"];

  // Go through existing playlists and clean up albums array
  for (const playlist of Object.values(library.playlists)) {
    if (isAlbumPlaylist(playlist)) {
      const albumsToReplace: [number, string][] = [];
      playlist.albums.forEach((album, index) => {
        if (!(typeof album === "string")) {
          const foundAlbum =
            library.albums[album.id] ??
            Object.values(library.albums).find(
              (a) =>
                a.spotify.name === album.name &&
                a.spotify.artists[0].name === album.artists[0].name
            );
          if (foundAlbum) {
            albumsToReplace.push([index, foundAlbum.id.spotify]);
          }
        }
      });

      albumsToReplace.forEach(([index, id]) => (playlist.albums[index] = id));
    }
  }

  for (const id of chartPlaylists) {
    if (library.playlists[id]) return;

    debug(`Scraping album playlist ${id}`);

    const playlist = await getPlaylist(id);
    const albums = await getPlaylistAlbums(id);

    if (playlist?.id && albums) {
      debug(`Saving album playlist ${playlist.name}`);
      library.playlists[playlist.id] = {
        ...playlist,
        tracks: undefined,
        // If album is in library, just add album ID
        albums: albums?.map((a) => {
          if (library.albums[a.id]) {
            if (!library.albums[a.id].playlists.includes(playlist.id)) {
              library.albums[a.id].playlists.push(playlist.id);
            }
            return a.id;
          }
          return a;
        }),
        chart: true,
        ascending: true,
      };

      // Go through albums and add link to playlist
    } else {
      debug(`FAILED to fetch chart playlist ${id}`);
    }
  }
}

export async function getPlaylistTracks(spotifyApi: SpotifyWebApi, id: string) {
  const unprocessedTracks: SpotifyApi.PlaylistTrackObject[] = [];

  await new Promise((resolve, reject) => {
    const getTracks = async (offset = 0, limit = 100) => {
      debug(`fetching spotify playlist tracks offset=${offset}`);
      try {
        const response = await spotifyLimiter.schedule(() =>
          spotifyApi.getPlaylistTracks(id, {
            limit,
            offset,
          })
        );

        unprocessedTracks.push(...response.body.items);

        const nextOffset = response.body.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getTracks(parseInt(nextOffset, 10));
        } else {
          debug(`FINISHED fetching spotify playlist tracks`);
          resolve("done");
        }
      } catch (error) {
        debug(`FAILED to fetched spotify playlist tracks offset=${offset}`);
        debug(error);
        reject();
      }
    };

    getTracks();
  });

  return unprocessedTracks;
}

export async function playlistHasTracks(
  spotifyApi: SpotifyWebApi,
  playlistId: string,
  trackIds: string[]
) {
  return await new Promise<boolean>((resolve, reject) => {
    const getTracks = async (offset = 0, limit = 100) => {
      debug(`fetching spotify playlist tracks offset=${offset}`);
      try {
        const response = await spotifyLimiter.schedule(() =>
          spotifyApi.getPlaylistTracks(playlistId, {
            limit,
            offset,
          })
        );

        const currentTracks = trackIds.slice(offset, offset + limit);
        if (
          currentTracks.length !== response.body.items.length ||
          currentTracks.some(
            (trackId, index) => response.body.items[index].track?.id !== trackId
          )
        ) {
          debug(`FINISHED playlist does not have tracks`);
          resolve(false);
        }

        const nextOffset = response.body.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getTracks(parseInt(nextOffset, 10));
        } else {
          debug(`FINISHED playlist has all tracks`);
          resolve(true);
        }
      } catch (error) {
        debug(`FAILED to fetched spotify playlist tracks offset=${offset}`);
        debug(error);
        reject();
      }
    };

    getTracks();
  });
}

export async function getPlaylistAlbums(id: string) {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);
    const tracks = await getPlaylistTracks(spotifyApi, id);
    const albums = tracks.reduce<SpotifyApi.AlbumObjectSimplified[]>(
      (acc, track) => {
        if (track.track && !acc.find((a) => a.id === track.track!.album.id)) {
          acc.push(track.track.album);
        }
        return acc;
      },
      []
    );
    return albums;
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }
}

export async function getPlaylist(id: string) {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);
    try {
      const response = await spotifyLimiter.schedule(() =>
        spotifyApi.getPlaylist(id)
      );
      return response.body;
    } catch (error) {
      debug(`FAILED to fetched spotify playlist ${id}`);
      debug(error);
    }
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }
}

export async function getPlaylistTracksWithMetadata(
  id: string
): Promise<SpotifyPlaylistTrack[] | undefined> {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);

    const unprocessedTracks = await getPlaylistTracks(spotifyApi, id);
    const artistsToFetch = new Set<string>();
    unprocessedTracks.forEach((t) =>
      t.track?.artists.forEach((a) => artistsToFetch.add(a.id))
    );
    const unprocessedArtists = await getArtists(
      spotifyApi,
      Array.from(artistsToFetch)
    );
    const unprocessedAudioFeatures = await getAudioFeatures(
      spotifyApi,
      unprocessedTracks.filter((t) => t.track).map((t) => t.track!.id)
    );

    return unprocessedTracks.map((track) => {
      return {
        ...track,
        audioFeatures: unprocessedAudioFeatures.find(
          (a) => a.id === track.track?.id
        ),
        artists: (track.track?.artists
          .map((artist) => unprocessedArtists.find((a) => a.id === artist.id))
          .filter((a) => typeof a !== "undefined") ??
          []) as SpotifyApi.ArtistObjectFull[],
      };
    });
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }
}

export async function getUserPlaylists(spotifyApi: SpotifyWebApi) {
  const usersPlaylists: SpotifyApi.PlaylistObjectSimplified[] = [];

  await new Promise((resolve, reject) => {
    const getPlaylists = async (offset = 0, limit = 50) => {
      debug(`fetching users spotify playlists offset=${offset}`);
      try {
        const response = await spotifyLimiter.schedule(() =>
          spotifyApi.getUserPlaylists({
            limit,
            offset,
          })
        );

        usersPlaylists.push(...response.body.items);

        const nextOffset = response.body.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getPlaylists(parseInt(nextOffset, 10));
        } else {
          debug(`FINISHED fetching users spotify playlists`);
          resolve("done");
        }
      } catch (error) {
        debug(`FAILED to users spotify playlists offset=${offset}`);
        debug(error);
        reject();
      }
    };

    getPlaylists();
  });

  return usersPlaylists;
}

export async function addTracksToPlaylist(
  spotifyApi: SpotifyWebApi,
  playlistId: string,
  /** array of track IDS */
  trackIds: string[]
) {
  const limit = 100;

  const trackUris = trackIds.map((id) => `spotify:track:${id}`);
  const numBatches = Math.ceil(trackUris.length / limit);

  debug(
    `adding ${trackUris.length} tracks to playlist ${playlistId} - will take ${numBatches} requests to complete`
  );

  const tracksBatch = new Array(numBatches)
    .fill(0)
    .map((v, index) => trackUris.slice(index * limit, (index + 1) * limit));

  await Promise.all(
    tracksBatch.map((batch, i) =>
      spotifyLimiter.schedule(async () => {
        debug(`adding tracks to playlist ${playlistId} offset=${i * limit}`);
        await spotifyApi.addTracksToPlaylist(playlistId, batch);
      })
    )
  );

  debug(`FINISHED adding tracks to playlist ${playlistId}`);
}

export async function removeAllTracksFromPlaylist(
  spotifyApi: SpotifyWebApi,
  playlistId: string,
  snapshotId: string,
  /** array of track IDS */
  numberOfTracks: number
) {
  const limit = 100;

  const numBatches = Math.ceil(numberOfTracks / limit);

  debug(
    `deleting ${numberOfTracks} tracks from playlist ${playlistId} - will take ${numBatches} requests to complete`
  );

  /**
   * Spotify API only allows you to remove 100 tracks at a time
   * so we need to batch the requests. For example:
   * - `0-99`
   * - `100-199`
   * - ...
   */
  const trackPositionsBatches = new Array(numBatches)
    .fill(0)
    .map((_, batchIndex) =>
      new Array(Math.min(limit, numberOfTracks - batchIndex * limit))
        .fill(0)
        .map((_, innerIndex) => innerIndex + batchIndex * limit)
    );

  await Promise.all(
    trackPositionsBatches.map((trackPositions, i) =>
      spotifyLimiter.schedule(async () => {
        debug(
          `removing tracks from playlist ${playlistId} tracks=${trackPositions.join(
            ","
          )}`
        );
        await spotifyApi.removeTracksFromPlaylistByPosition(
          playlistId,
          trackPositions,
          snapshotId
        );
      })
    )
  );

  debug(`FINISHED adding tracks to playlist ${playlistId}`);
}

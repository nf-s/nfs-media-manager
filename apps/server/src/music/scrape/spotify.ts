import Bottleneck from "bottleneck";
import debugPkg from "debug";
import SpotifyWebApi from "spotify-web-api-node";
import { library, Source } from "../index.js";
const debug = debugPkg.debug("music-scraper:spotify");

export interface SpotifySavedAlbum extends SpotifyApi.AlbumObjectFull {
  addedDate: string;
  audioFeatures: SpotifyApi.AudioFeaturesObject[];
}

export const spotifyLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1500,
  timeout: 5000,
});

/**
 *
 * @param lazyScrape If true, then scraping spotify albums will stop when an existing album is found
 */
export async function scrapeSpotifyAlbums(
  spotifyApi: SpotifyWebApi,
  lazyScrape = true
) {
  let newAlbums = 0;

  await new Promise((resolve, reject) => {
    const getAlbums = async (offset = 0, limit = 50) => {
      spotifyLimiter.schedule(async () => {
        debug(`fetching spotify albums offset=${offset}`);
        try {
          const response = await spotifyApi.getMySavedAlbums({
            limit,
            offset,
          });

          let continueScraping = true;

          response.body.items.forEach((savedAlbum) => {
            if (lazyScrape && library.albums[savedAlbum.album.id]) {
              continueScraping = false;
            } else if (
              !library.albums[savedAlbum.album.id] &&
              !library.blacklistedAlbums?.includes(savedAlbum.album.id)
            ) {
              newAlbums += 1;
              library.albums[savedAlbum.album.id] = {
                id: {
                  spotify: savedAlbum.album.id,
                  upc: savedAlbum.album.external_ids.upc,
                },
                spotify: {
                  addedDate: savedAlbum.added_at,
                  ...savedAlbum.album,
                  audioFeatures: [],
                },
                source: { type: "spotify" },
                playlists: [],
              };
            }
          });

          const nextOffset = response.body.next
            ?.match(/offset=([0-9]+)/g)?.[0]
            ?.split("=")?.[1];
          if (nextOffset && continueScraping) {
            getAlbums(parseInt(nextOffset));
          } else {
            debug(`FINISHED fetching spotify albums`);
            resolve("done");
          }
        } catch (error) {
          debug(`FAILED to fetched spotify albums offset=${offset}`);
          debug(error);
          reject();
        }
      });
    };

    getAlbums();
  });

  debug(`imported ${newAlbums} new albums from spotify`);
  debug(
    `library has ${
      Object.keys(library.albums).length
    } total albums from spotify`
  );
}

export async function scrapeSpotifyAlbumArtists(spotifyApi: SpotifyWebApi) {
  try {
    const artistsToFetch = Object.values(library.albums)
      .map((a) => a.spotify.artists.map((b) => b.id))
      .flat()
      .filter((id) => !library.artists[id]);
    const artists = await getArtists(spotifyApi, artistsToFetch);

    for (const artist of artists) {
      library.artists[artist.id] = { spotify: artist };
    }
  } catch (e) {
    debug(`FAILED to fetch album artists`);
    throw e;
  }
}

export async function scrapeSpotifyAlbumAudioFeatures(
  spotifyApi: SpotifyWebApi
) {
  debug("Fetching audio features");

  // Get audio features

  const albumsWhichNeedFeatures = Object.values(library.albums).filter(
    (album) =>
      album.spotify.audioFeatures === undefined ||
      album.spotify.audioFeatures === null ||
      album.spotify.audioFeatures.length === 0
  );

  // Flat array of track IDs
  const trackIds = albumsWhichNeedFeatures.reduce<string[]>((tracks, album) => {
    album.spotify.audioFeatures = [];
    tracks.push(...album.spotify.tracks.items.map((t) => t.id));
    return tracks;
  }, []);

  const tracksAudioFeatures = await getAudioFeatures(spotifyApi, trackIds);

  // Go through audioFeatures and albums to instert trackFeatures into correct album
  for (let i = 0; i < tracksAudioFeatures.length; i++) {
    const track = tracksAudioFeatures[i];

    for (let j = 0; j < albumsWhichNeedFeatures.length; j++) {
      const album = albumsWhichNeedFeatures[j];
      if (
        album.spotify.tracks.items.find(
          (t) => t !== null && track !== null && t.id === track.id
        )
      ) {
        album.spotify.audioFeatures.push(track);
      }
    }
  }
}

export async function searchSpotify(
  spotifyApi: SpotifyWebApi,
  albums: Source[]
) {
  let newAlbums = 0;
  let updatedAlbums = 0;
  const notFound: Source[] = [];

  await Promise.all(
    albums.map((row) =>
      row.type !== "spotify"
        ? (async () => {
            const q = `${row.artist} ${row.title}`;
            debug(`searching for ${q}`);
            try {
              const response = await spotifyLimiter.schedule(() =>
                spotifyApi.searchAlbums(q)
              );

              const found = response.body.albums?.items[0];

              if (found) {
                if (!library.albums[found.id]) {
                  debug(
                    `Found NEW ALBUM match for ${q}: ${found.artists
                      .map((a) => a.name)
                      .join(", ")} - ${found.name}`
                  );
                  newAlbums += 1;
                  const fullAlbum = (
                    await spotifyLimiter.schedule(() =>
                      spotifyApi.getAlbum(found.id)
                    )
                  ).body;

                  library.albums[fullAlbum.id] = {
                    id: {
                      spotify: fullAlbum.id,
                    },
                    spotify: {
                      addedDate: row.addedDate ?? new Date().toString(),
                      ...fullAlbum,
                      audioFeatures: [],
                    },
                    source: row,
                    playlists: [],
                  };
                } else {
                  debug(
                    `Found EXISTING ALBUM match for ${q}: ${found.artists
                      .map((a) => a.name)
                      .join(", ")} - ${found.name}`
                  );
                  updatedAlbums += 1;
                  library.albums[found.id].spotify.addedDate =
                    row.addedDate ?? new Date().toString();
                }
              } else {
                debug(`NO Found match for ${q}`);
                library.missing.push(row);
                notFound.push(row);
              }
            } catch (error) {
              debug(`FAILED to search for ${q}`);
              debug(error);
            }
          })()
        : undefined
    )
  );
  if (notFound.length > 0) {
    debug(`WARNING albums not found: ${notFound.length}`);
    debug(notFound);
  }

  debug(`imported ${newAlbums} new albums from spotify`);
  debug(`updated ${updatedAlbums} existing albums from spotify`);

  debug(
    `library has ${
      Object.keys(library.albums).length
    } total albums from spotify`
  );

  return { newAlbums, updatedAlbums, notFound };
}

export async function getArtists(spotifyApi: SpotifyWebApi, ids: string[]) {
  debug(`Fetching data for ${ids.length} artists`);

  const numArtistBatches = Math.ceil(ids.length / 50);

  const artistsBatch = new Array(numArtistBatches)
    .fill(0)
    .map((v, index) => ids.slice(index * 50, (index + 1) * 50));

  const artistObjects: SpotifyApi.ArtistObjectFull[] = [];

  await Promise.all(
    artistsBatch.map((batch, i) =>
      spotifyLimiter.schedule(async () => {
        debug(`fetching spotify artists offset=${i * 50}`);
        const artists = await spotifyApi.getArtists(batch);

        artistObjects.push(...artists.body.artists);
      })
    )
  );

  return artistObjects;
}

export async function getAudioFeatures(
  spotifyApi: SpotifyWebApi,
  ids: string[]
) {
  debug(`Fetching audio features for ${ids.length} tracks`);

  const numBatches = Math.ceil(ids.length / 100);

  const tracksBatch = new Array(numBatches)
    .fill(0)
    .map((v, index) => ids.slice(index * 100, (index + 1) * 100));

  const tracks: SpotifyApi.AudioFeaturesObject[] = [];
  await Promise.all(
    tracksBatch.map((batch, i) =>
      spotifyLimiter.schedule(async () => {
        debug(`fetching spotify track audo features offset=${i * 100}`);
        const audioFeatures = await spotifyApi.getAudioFeaturesForTracks(batch);

        tracks.push(...audioFeatures.body.audio_features);
      })
    )
  );

  return tracks;
}

export async function getCurrentSpotifyUser(spotifyApi: SpotifyWebApi) {
  return (await spotifyLimiter.schedule(() => spotifyApi.getMe())).body;
}

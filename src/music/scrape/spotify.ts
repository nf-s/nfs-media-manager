import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import SpotifyWebApi from "spotify-web-api-node";
import { library, Source } from "..";
const debug = debugInit("music-scraper:spotify");

export interface SpotifySavedAlbum extends SpotifyApi.AlbumObjectFull {
  addedDate: string;
  audioFeatures: SpotifyApi.AudioFeaturesObject[];
}

const spotifyLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000,
});

export async function scrapeSpotify() {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);

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

            response.body.items.forEach((savedAlbum) => {
              if (!library.albums[savedAlbum.album.id]) {
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
                };
              }
            });
            const nextOffset = response.body.next
              ?.match(/offset=([0-9]+)/g)?.[0]
              ?.split("=")?.[1];
            if (nextOffset) {
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
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }
}

export async function spotifyAudioFeatures() {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);

    debug("Fetching audio features");

    // Get audio features

    // Flat array of track IDs
    const trackIds = Object.values(library.albums)
      .filter(
        (album) =>
          album.spotify.audioFeatures === undefined ||
          album.spotify.audioFeatures === null ||
          album.spotify.audioFeatures.length === 0
      )
      .reduce<string[][]>((tracks, album) => {
        album.spotify.audioFeatures = [];
        tracks.push(
          ...album.spotify.tracks.items.map((t) => [album.spotify.id, t.id])
        );
        return tracks;
      }, []);

    debug(`Fetching audio features for ${trackIds.length} tracks`);

    const numBatches = Math.ceil(trackIds.length / 100);

    const tracksBatch = new Array(numBatches)
      .fill(0)
      .map((v, index) => trackIds.slice(index * 100, (index + 1) * 100));

    await Promise.all(
      tracksBatch.map((batch, i) =>
        spotifyLimiter.schedule(async () => {
          debug(`fetching spotify track audo features offset=${i * 100}`);
          const audioFeatures = await spotifyApi.getAudioFeaturesForTracks(
            batch.map(([albumId, trackId]) => trackId)
          );
          audioFeatures.body.audio_features.forEach((track) => {
            if (track === null) return;
            const albumId = batch.find(
              ([albumId, trackId]) => track.id === trackId
            )?.[0];
            if (albumId) {
              library.albums[albumId].spotify.audioFeatures.push(track);
            }
          });
        })
      )
    );
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }
}

export async function searchSpotify(albums: Source[]) {
  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);

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
      console.log(notFound);
    }

    debug(`imported ${newAlbums} new albums from spotify`);
    debug(`updated ${updatedAlbums} existing albums from spotify`);

    debug(
      `library has ${
        Object.keys(library.albums).length
      } total albums from spotify`
    );

    return { newAlbums, updatedAlbums, notFound };
  } else {
    debug(`warning, SPOTIFY_TOKEN is not set - so can't seach for matches`);
  }
}

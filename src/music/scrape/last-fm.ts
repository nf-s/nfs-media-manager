import { IAlbum } from "@toplast/lastfm/lib/common/common.interface";
import { ApiRequest } from "@toplast/lastfm/lib/modules/request/request.service";
import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { albumTitle, library } from "..";

interface GetAlbumReponse {
  album: AlbumResponse;
}

type AlbumResponse = IAlbum & {
  userplaycount?: string;
  listeners?: string;
  tags?: { tag: { name: string; url: string }[] };
};

export type LastFmAlbum = AlbumResponse & { dateScraped: string };

const debug = debugInit("music-scraper:last-fm");

export async function scrapeLastFm() {
  if (process.env.LASTFM_API_KEY && process.env.LASTFM_USERNAME) {
    debug(`connected to Last.fm`);
    const api = new ApiRequest();

    const lfmLimiteer = new Bottleneck({
      maxConcurrent: 5,
      minTime: 200,
      timeout: 5000,
    });

    const getAlbum = async (
      params: { mbid: string } | { artist: string; album: string }
    ) => {
      return await lfmLimiteer.schedule(async () => {
        try {
          if ("mbid" in params) {
            debug(`fetching Last.fm with MBID ${params.mbid}`);
          } else {
            debug(
              `fetching Last.fm with artist-album title: ${params.artist} - ${params.album}`
            );
          }
          return (
            (await api.lastFm("album.getInfo", process.env.LASTFM_API_KEY!, {
              ...params,
              username: process.env.LASTFM_USERNAME,
              autocorrect: 1,
            } as any)) as unknown as GetAlbumReponse
          ).album;
        } catch (e) {
          debug(`FAILED to get album ${JSON.stringify(params)}`);
        }
      });
    };

    const albumsToFind = Object.values(library.albums)
      // Filter albums which have no LastFm metadata
      // Or haven't been scraped in last 15 days
      .filter(
        (album) =>
          album.lastFm === undefined ||
          (process.env.RETRY_FAILED === "true" && album.lastFm === null) ||
          (album.lastFm &&
            (!album.lastFm.dateScraped ||
              new Date(album.lastFm.dateScraped).getTime() <
                new Date().getTime() - 15 * 24 * 60 * 60 * 1000)) // refresh every 15 days
      );

    let counter = 0;

    await Promise.all(
      albumsToFind.map(async (album) => {
        let lfmAlbum: AlbumResponse | undefined;
        try {
          // Use lastFm album and artist name if already set
          if (album.lastFm) {
            const artist =
              typeof album.lastFm?.artist === "string"
                ? album.lastFm?.artist
                : album.lastFm?.artist?.name;
            if (album.lastFm.name && artist) {
              debug(`Refreshing album ${albumTitle(album)}`);
              lfmAlbum = await getAlbum({
                artist,
                album: album.lastFm.name,
              });
            }
          }

          // Try music brainz ID
          if (!lfmAlbum && album.id.musicBrainz) {
            lfmAlbum = await getAlbum({ mbid: album.id.musicBrainz });
          }

          // Search with spotify artist and name
          if (!lfmAlbum) {
            lfmAlbum = await getAlbum({
              artist: album.spotify.artists[0].name,
              album: album.spotify.name,
            });
          }

          if (lfmAlbum) {
            album.lastFm = {
              ...lfmAlbum,
              dateScraped: new Date().toISOString(),
            };
            debug(`SUCCESSFULLY fetched last.fm ${albumTitle(album)}`);
          } else {
            debug(`FAILED to fetched lastFm ${albumTitle(album)}`);
            album.lastFm = null;
          }
        } catch (error) {
          debug(`FAILED to fetched lastFm ${albumTitle(album)}`);
          debug(error);
          album.lastFm = null;
        }
        counter++;
        debug(`DONE ${(counter * 100) / albumsToFind.length}%`);
      })
    );
  } else {
    debug(`WARNING, LASTFM_API_KEY && LASTFM_USERNAME have not been set`);
  }

  // Calculate how many albums have lfm metadata
  const lfmFound = Object.values(library.albums).filter((a) => a.lastFm).length;

  debug(
    `library has Last.fm metadata for ${lfmFound}/${
      Object.entries(library.albums).length
    } (${(lfmFound * 100) / Object.entries(library.albums).length}%) found`
  );
}

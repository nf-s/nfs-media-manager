import LastFm from "@toplast/lastfm";
import { IAlbum } from "@toplast/lastfm/lib/common/common.interface";
import { ApiRequest } from "@toplast/lastfm/lib/modules/request/request.service";
import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { albumTitle, library, save } from "..";

interface GetAlbumReponse {
  album: LastFmAlbum;
}

export interface LastFmAlbum extends IAlbum {
  userplaycount?: string;
  listeners?: string;
  tags?: { tag: { name: string; url: string }[] };
}

const debug = debugInit("music-scraper:last-fm");

export async function scrapeLastFm() {
  if (process.env.LASTFM_API_KEY && process.env.LASTFM_USERNAME) {
    const lastFm = new LastFm(process.env.LASTFM_API_KEY);
    debug(`connected to Last.fm`);
    const api = new ApiRequest();

    const lfmLimiteer = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1000,
    });

    const getAlbum = async (
      params: { mbid: string } | { artist: string; album: string }
    ) => {
      const response = (await lfmLimiteer.schedule(
        async () =>
          api.lastFm("album.getInfo", process.env.LASTFM_API_KEY!, {
            ...params,
            username: process.env.LASTFM_USERNAME,
            autocorrect: 1,
          } as any) as unknown
      )) as GetAlbumReponse;

      if (!response.album) return;

      return response.album;
    };

    await Promise.all(
      Object.values(library.albums)
        // Filter albums which have no LastFm metadata
        .filter(
          (album) =>
            album.lastFm === undefined ||
            (process.env.RETRY_FAILED === "true" && album.lastFm === null)
        )
        .map(async (album) => {
          let lfmAlbum: LastFmAlbum | undefined;
          try {
            if (album.id.musicBrainz) {
              debug(`fetching Last.fm with MBID ${album.id.musicBrainz}`);
              lfmAlbum = await getAlbum({ mbid: album.id.musicBrainz! });
            }

            if (!lfmAlbum) {
              debug(
                `NO album found with MBID - trying artist-album title: ${albumTitle(
                  album
                )}`
              );
              lfmAlbum = await getAlbum({
                artist: album.spotify.artists[0].name,
                album: album.spotify.name,
              });
            }

            if (lfmAlbum) {
              album.lastFm = lfmAlbum;
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
        })
    );
    await save();
  }

  // Calculate how many albums have lfm metadata
  const lfmFound = Object.values(library.albums).filter((a) => a.lastFm).length;

  debug(
    `library has Last.fm metadata for ${lfmFound}/${
      Object.entries(library.albums).length
    } (${(lfmFound * 100) / Object.entries(library.albums).length}%) found`
  );
}

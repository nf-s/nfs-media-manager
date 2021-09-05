// tslint:disable-next-line: no-var-requires
require("dotenv").config();

import { debug as debugInit } from "debug";
import { IReleaseGroup } from "musicbrainz-api";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs";
import { clean } from "./clean";
import { albumCsv } from "./scrape/album-csv";
import {
  discogs,
  DiscogsMaster,
  DiscogsRelease,
  DiscogsReleaseWithRating,
} from "./scrape/discogs";
import { LastFmAlbum, scrapeLastFm as lastFm } from "./scrape/last-fm";
import { musicBrainz } from "./scrape/mb";
import { scrapeSpotify } from "./scrape/spotify";
import { upcCsv } from "./scrape/upc-csv";

const debug = debugInit("music-scraper:init");

debug("HELLO!");

// SETUP data directories
if (typeof process.env.DATA_DIR === "undefined")
  throw new Error("DATA_DIR must be set to a valid directory");

// SETUP library JSON blob
export const LIBRARY_PATH = join(process.env.DATA_DIR, "lib-music.json");

interface SpotifySavedAlbum extends SpotifyApi.AlbumObjectFull {
  addedDate: string;
  audioFeatures: SpotifyApi.AudioFeaturesObject[];
}

export type AlbumId = {
  spotify: string;
  upc?: string;
  rymUrl?: string;
  musicBrainz?: string;
  discogs?: string;
};

export type Source =
  | { type: "spotify" }
  | {
      type: "album_csv";
      artist: string;
      title: string;
      filename: string;
      addedDate?: string;
    }
  | {
      type: "upc_csv";
      artist: string;
      title: string;
      upc: string;
      filename: string;
      addedDate?: string;
    };

interface Album {
  discogs?: {
    master: DiscogsMaster;
    releases?: DiscogsRelease[];
    /** Only top 10 releases will have ratings */
    releasesWithRatings?: DiscogsReleaseWithRating[];
  } | null;
  mb?: { releaseGroup: IReleaseGroup } | null;
  lastFm?: LastFmAlbum | null;
  id: AlbumId;
  spotify: SpotifySavedAlbum;
  source: Source;
}

interface Library {
  albums: { [id: string]: Album };
  missing: Source[];
}

export const library: Library = { albums: {}, missing: [] };

export const albumTitle = (a: Album) =>
  `${a.spotify.artists[0].name}-${a.spotify.name}`;

export async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

export function skip(key: string) {
  return (process.env.SKIP?.split(",") ?? []).includes(key);
}

async function init() {
  // Load library
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nreading...`);
    const lib = (await readJSONFile(LIBRARY_PATH, debug)) as {
      albums: { [id: string]: SpotifySavedAlbum };
    };

    Object.assign(library, lib);

    debug(`library has ${Object.keys(library.albums).length} albums loaded`);
  }

  if (!skip("album-csv")) await albumCsv();

  if (!skip("upc")) await upcCsv();

  if (!skip("spotify")) await scrapeSpotify();

  if (!skip("mb")) await musicBrainz();

  if (!skip("discogs")) await discogs();

  if (!skip("lastfm")) await lastFm();

  debug(
    `library has ${
      Object.keys(library.albums).length
    } total albums from spotify`
  );

  debug(`library has ${library.missing.length} missing albums`);

  if (!skip("clean") && process.env.MUSIC_CLEAN_JSON) {
    const cleanLibrary = await clean();

    debug("saving cleaned library file");

    await writeFile(
      process.env.MUSIC_CLEAN_JSON,
      JSON.stringify(cleanLibrary),
      undefined,
      debug
    );
  }
}

init();

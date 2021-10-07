// tslint:disable-next-line: no-var-requires
require("dotenv").config();

import { debug as debugInit } from "debug";
import { IReleaseGroup } from "musicbrainz-api";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs";
import { clean } from "./clean";
import { clean as cleanPlaylist } from "./clean-playlist";
import { albumCsv } from "./scrape/album-csv";
import {
  discogs,
  DiscogsMaster,
  DiscogsMasterRelease,
  DiscogsMasterReleaseWithRating,
  DiscogsRelease,
} from "./scrape/discogs";
import { LastFmAlbum, scrapeLastFm as lastFm } from "./scrape/last-fm";
import { musicBrainz } from "./scrape/mb";
import {
  GoogleResult,
  metacriticGoogleRelease,
  RymGoogle,
  rymGoogleRelease,
} from "./scrape/google-custom-search";
import {
  getPlaylist,
  scrapeSpotify,
  spotifyAudioFeatures,
  SpotifyPlaylistTrack,
  SpotifySavedAlbum,
} from "./scrape/spotify";
import { upcCsv } from "./scrape/upc-csv";
import { AlbumId } from "./interfaces";

const debug = debugInit("music-scraper:init");

debug("HELLO!");

// SETUP data directories
if (typeof process.env.DATA_DIR === "undefined")
  throw new Error("DATA_DIR must be set to a valid directory");

// SETUP library JSON blob
export const LIBRARY_PATH = join(process.env.DATA_DIR, "lib-music.json");

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

export interface Album {
  discogs?:
    | {
        master: DiscogsMaster;
        releases?: DiscogsMasterRelease[];
        /** Only top 10 releases will have ratings */
        releasesWithRatings?: DiscogsMasterReleaseWithRating[];
      }
    | {
        release: DiscogsRelease;
      }
    | null;
  mb?: { releaseGroup: IReleaseGroup } | null;
  lastFm?: LastFmAlbum | null;
  id: AlbumId;
  spotify: SpotifySavedAlbum;
  rymGoogle?: RymGoogle | null;
  metacriticGoogle?: GoogleResult | null;
  source: Source | undefined;
}

interface Library {
  albums: { [id: string]: Album };
  playlists: { [id: string]: SpotifyPlaylistTrack[] };
  missing: Source[];
}

export const library: Library = { albums: {}, missing: [], playlists: {} };

export const albumTitle = (a: Album) =>
  `${a.spotify.artists[0].name}-${a.spotify.name}`;

export async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

export function skip(key: string) {
  return (process.env.SKIP?.split(",") ?? []).includes(key);
}

async function run() {
  const playlist = await getPlaylist("2MSLhlwifL3i8b8vDZJ3h2");

  if (!playlist) return;

  const cleanedPlaylist = await cleanPlaylist(playlist);

  await writeFile(
    join(process.env.DATA_DIR!, "2MSLhlwifL3i8b8vDZJ3h2.json"),
    JSON.stringify(cleanedPlaylist),
    undefined,
    debug
  );

  return;

  // Load library
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nreading...`);
    const lib = (await readJSONFile(LIBRARY_PATH, debug)) as {
      albums: { [id: string]: SpotifySavedAlbum };
    };

    Object.assign(library, lib);

    debug(`library has ${Object.keys(library.albums).length} albums loaded`);

    debug(`Backing up lib to ${LIBRARY_PATH}-backup`);
    await writeFile(
      `${LIBRARY_PATH}-backup`,
      JSON.stringify(lib),
      undefined,
      debug
    );
  }

  debug("Start scraping!");

  try {
    if (!skip("album-csv")) await albumCsv();

    if (!skip("upc")) await upcCsv();

    if (!skip("spotify-fav")) await scrapeSpotify();
  } catch (e) {
    debug(e);
    debug("ERROR occured while scraping new albums");
  }

  await save();

  // These can all be done in parallel
  try {
    await Promise.all([
      !skip("spotify-audio-features")
        ? spotifyAudioFeatures()
        : Promise.resolve(),
      !skip("mb") ? musicBrainz() : Promise.resolve(),
      !skip("discogs") ? discogs() : Promise.resolve(),
      !skip("lastfm") ? lastFm() : Promise.resolve(),
      !skip("rym") ? rymGoogleRelease() : Promise.resolve(),
      !skip("metacritic") ? metacriticGoogleRelease() : Promise.resolve(),
    ]);
  } catch (e) {
    debug(e);
    debug("ERROR occured while scraping metadata for albums");
  }

  await save();

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
      process.env.MUSIC_CLEAN_JSON!,
      JSON.stringify(cleanLibrary),
      undefined,
      debug
    );
  }
}

run();

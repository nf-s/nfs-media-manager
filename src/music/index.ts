// tslint:disable-next-line: no-var-requires
require("dotenv").config();

import { debug as debugInit } from "debug";
import { IReleaseGroup } from "musicbrainz-api";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs";
import { skip } from "../util/skip";
import { clean } from "./clean";
import { clean as cleanPlaylist } from "./clean-playlist";
import { AlbumId, CleanLibrary } from "./interfaces";
import { albumCsv } from "./scrape/album-csv";
import {
  discogs,
  DiscogsMaster,
  DiscogsMasterRelease,
  DiscogsMasterReleaseWithRating,
  DiscogsRelease,
} from "./scrape/discogs";
import {
  GoogleResult,
  metacriticGoogleRelease,
  RymGoogle,
  rymGoogleRelease,
} from "./scrape/google-custom-search";
import { LastFmAlbum, scrapeLastFm as lastFm } from "./scrape/last-fm";
import { musicBrainz } from "./scrape/mb";
import {
  scrapeSpotifyAlbumArtists,
  scrapeSpotifyAlbumAudioFeatures,
  scrapeSpotifyAlbums,
  SpotifySavedAlbum,
} from "./scrape/spotify";
import {
  scrapeSpotifyAlbumPlaylists,
  scrapeSpotifyTrackPlaylists,
  SpotifyPlaylistTrack,
} from "./scrape/spotify-playlist";
import { upcCsv } from "./scrape/upc-csv";
import { syncPlaylists } from "./sync-playlist";

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
  playlists: string[];
}

export interface Artist {
  spotify: SpotifyApi.ArtistObjectFull;
}

export type Playlist = TrackPlaylist | AlbumPlaylist;

interface PlaylistBase extends SpotifyApi.PlaylistBaseObject {
  chart: boolean;
  /** Chart playlists starts at 1. (Defaults to true) */
  ascending: boolean;
}
export interface TrackPlaylist extends PlaylistBase {
  tracks: SpotifyPlaylistTrack[];
}

export interface AlbumPlaylist extends PlaylistBase {
  albums: (SpotifyApi.AlbumObjectSimplified | string)[];
  tracks: undefined;
}

export function isTrackPlaylist(p: Playlist): p is TrackPlaylist {
  return !isAlbumPlaylist(p) && Array.isArray(p.tracks);
}

export function isAlbumPlaylist(p: Playlist): p is AlbumPlaylist {
  return "albums" in p;
}

interface Library {
  albums: { [id: string]: Album };
  artists: { [id: string]: Artist };
  playlists: { [id: string]: Playlist };
  missing: Source[];
}

export const library: Library = {
  albums: {},
  artists: {},
  missing: [],
  playlists: {},
};

export const albumTitle = (a: Album) =>
  `${a.spotify.artists[0].name}-${a.spotify.name}`;

async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

async function run() {
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

  debug("Start scraping albums!");

  try {
    if (!skip("album-csv")) await albumCsv();

    if (!skip("upc")) await upcCsv();

    if (!skip("spotify-fav")) await scrapeSpotifyAlbums();
  } catch (e) {
    debug(e);
    debug("ERROR occurred while scraping new albums");
  }

  if (!skip("album-csv") || !skip("upc") || !skip("spotify-fav")) await save();

  debug("Start scraping playlists!");

  if (!skip("spotify-album-playlists")) await scrapeSpotifyAlbumPlaylists();
  if (!skip("spotify-track-playlists")) await scrapeSpotifyTrackPlaylists();

  if (!skip("spotify-album-playlists") || !skip("spotify-track-playlists"))
    await save();

  debug("Start scraping metadata!");

  // These can all be done in parallel
  try {
    await Promise.all([
      !skip("spotify-artists")
        ? scrapeSpotifyAlbumArtists()
        : Promise.resolve(),
      !skip("spotify-audio-features")
        ? scrapeSpotifyAlbumAudioFeatures()
        : Promise.resolve(),
      !skip("mb") ? musicBrainz() : Promise.resolve(),
      !skip("discogs") ? discogs() : Promise.resolve(),
      !skip("lastfm") ? lastFm() : Promise.resolve(),
      !skip("rym") ? rymGoogleRelease() : Promise.resolve(),
      !skip("metacritic") ? metacriticGoogleRelease() : Promise.resolve(),
    ]);
  } catch (e) {
    debug(e);
    debug("ERROR occurred while scraping metadata for albums");
  }

  if (
    !skip("spotify-artists") ||
    !skip("spotify-audio-features") ||
    !skip("mb") ||
    !skip("discogs") ||
    !skip("lastfm") ||
    !skip("rym") ||
    !skip("metacritic")
  )
    await save();

  debug(
    `library has ${
      Object.keys(library.albums).length
    } total albums from spotify`
  );

  debug(`library has ${library.missing.length} missing albums`);

  if (process.env.MUSIC_CLEAN_JSON) {
    let cleanLibrary: CleanLibrary | undefined;
    if (!skip("clean") && process.env.MUSIC_CLEAN_JSON) {
      cleanLibrary = await clean();

      debug("saving cleaned library file");

      await writeFile(
        process.env.MUSIC_CLEAN_JSON!,
        JSON.stringify(cleanLibrary),
        undefined,
        debug
      );

      debug("saving cleaned track playlist files");

      for (const playlist of Object.values(library.playlists)) {
        if (isTrackPlaylist(playlist)) {
          debug(`saving playlist ${playlist.name}`);
          const cleanedPlaylist = await cleanPlaylist(playlist);

          await writeFile(
            join(process.env.DATA_DIR!, `${playlist.id}.json`),
            JSON.stringify(cleanedPlaylist),
            undefined,
            debug
          );
        }
      }
    }

    if (!cleanLibrary) {
      cleanLibrary = await readJSONFile(process.env.MUSIC_CLEAN_JSON);
    }

    await syncPlaylists(cleanLibrary!);
  } else {
    debug(
      "process.env.MUSIC_CLEAN_JSON is undefined - cannot save cleaned library or sync playlists"
    );
  }

  process.exit();
}

run();

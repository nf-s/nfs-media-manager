import debugPkg from "debug";
import { IReleaseGroup } from "musicbrainz-api";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs.js";
import { skip } from "../util/skip.js";
import { clean as cleanPlaylist } from "./clean/clean-playlist.js";
import { clean } from "./clean/index.js";
import { AlbumId, CleanLibrary } from "data-types";
import { removeDupes } from "./remove-dupe.js";
import { albumCsv } from "./scrape/album-csv.js";
import {
  discogs,
  DiscogsMaster,
  DiscogsMasterRelease,
  DiscogsMasterReleaseWithRating,
  DiscogsRelease,
} from "./scrape/discogs.js";
import {
  GoogleResult,
  metacriticGoogleRelease,
  RymGoogle,
  rymGoogleRelease,
} from "./scrape/google-custom-search.js";
import { LastFmAlbum, scrapeLastFm as lastFm } from "./scrape/last-fm.js";
import { musicBrainz } from "./scrape/mb.js";
import {
  scrapeSpotifyAlbumPlaylists,
  scrapeSpotifyTrackPlaylists,
  SpotifyPlaylistTrack,
} from "./scrape/spotify-playlist.js";
import {
  scrapeSpotifyAlbumArtists,
  scrapeSpotifyAlbumAudioFeatures,
  scrapeSpotifyAlbums,
  SpotifySavedAlbum,
} from "./scrape/spotify.js";
import { upcCsv } from "./scrape/upc-csv.js";
import { getSpotifyToken } from "./server.js";
import { syncPlaylists } from "./sync-playlist.js";

import dotenv from "dotenv";
import SpotifyWebApi from "spotify-web-api-node";

dotenv.config();
const debug = debugPkg.debug("music-scraper:init");

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
  blacklistedAlbums: string[];
}

export const library: Library = {
  albums: {},
  blacklistedAlbums: [],
  artists: {},
  missing: [],
  playlists: {},
};

export const albumTitle = (a: Album) =>
  `${a.spotify.artists.map((a) => a.name).join(", ")}-${a.spotify.name}`;

async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

export async function run() {
  const token = await getSpotifyToken();

  const spotifyApi = new SpotifyWebApi();
  spotifyApi.setAccessToken(token);

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
    if (!skip("album-csv")) await albumCsv(spotifyApi);

    if (!skip("upc")) await upcCsv(spotifyApi);

    if (!skip("spotify-fav")) await scrapeSpotifyAlbums(spotifyApi);
  } catch (e) {
    debug(e);
    debug("ERROR occurred while scraping new albums");
  }

  if (!skip("album-csv") || !skip("upc") || !skip("spotify-fav")) await save();

  debug("Start scraping playlists!");

  if (!skip("spotify-album-playlists"))
    await scrapeSpotifyAlbumPlaylists(spotifyApi);
  if (!skip("spotify-track-playlists"))
    await scrapeSpotifyTrackPlaylists(spotifyApi);

  if (!skip("spotify-album-playlists") || !skip("spotify-track-playlists"))
    await save();

  debug("Start scraping metadata!");

  // These can all be done in parallel
  try {
    await Promise.all([
      !skip("spotify-artists")
        ? scrapeSpotifyAlbumArtists(spotifyApi)
        : Promise.resolve(),
      !skip("spotify-audio-features")
        ? scrapeSpotifyAlbumAudioFeatures(spotifyApi)
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

  if (!skip("remove-dupes")) {
    await removeDupes();
    await save();
  }

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

    await syncPlaylists(spotifyApi, cleanLibrary!);
  } else {
    debug(
      "process.env.MUSIC_CLEAN_JSON is undefined - cannot save cleaned library or sync playlists"
    );
  }
}

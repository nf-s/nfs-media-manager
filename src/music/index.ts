require("dotenv").config();

import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { join } from "path";
import SpotifyWebApi from "spotify-web-api-node";
import { fileExists, readCsv, readJSONFile, writeFile } from "../util/fs";
import { clean } from "./clean";

const debug = debugInit("music-scraper:init");

debug("HELLO!");

// SETUP data directories
if (typeof process.env.DATA_DIR === "undefined")
  throw "DATA_DIR must be set to a valid directory";

// SETUP library JSON blob
export const LIBRARY_PATH = join(process.env.DATA_DIR, "lib-music.json");

interface SpotifySavedAlbum extends SpotifyApi.AlbumObjectFull {
  addedDate: string;
}

export const library: {
  albums: { [id: string]: SpotifySavedAlbum };
} = { albums: {} };

export async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

async function init() {
  // Load library
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nreading...`);
    Object.assign(library, await readJSONFile(LIBRARY_PATH, debug));

    debug(`library has ${Object.keys(library.albums).length} albums loaded`);
  }

  if (process.env.SPOTIFY_TOKEN) {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(process.env.SPOTIFY_TOKEN);

    debug(`connected to spotify`);

    const spotifyLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1000,
    });

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
                library.albums[savedAlbum.album.id] = {
                  addedDate: savedAlbum.added_at,
                  ...savedAlbum.album,
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

    await save();
  } else {
    debug(`WARNING no SPOTIFY_TOKEN provided`);
  }

  if (process.env.UPC_CSV && (await fileExists(process.env.UPC_CSV))) {
    debug(`Importing CSV with UPCs`);

    const csv = await readCsv(
      process.env.UPC_CSV,
      process.env.UPC_CSV_DELIMITER
    );

    const header = csv.splice(0, 1)[0];

    const upcIndex = header.indexOf("upc");
    const dateAddedIndex = header.indexOf("addedDate");

    const upcNotFound: string[][] = [];

    csv.forEach((row) => {
      const album = Object.values(library.albums).find(
        (album) =>
          album.external_ids.upc && album.external_ids.upc === row[upcIndex]
      );
      if (album) {
        debug(`Found album ${album.external_ids.upc}`);
        if (dateAddedIndex !== -1) {
          album.addedDate = row[dateAddedIndex];
          debug(`Overwritting addedDate to ${row[dateAddedIndex]}`);
        }
      } else {
        upcNotFound.push(row);
      }
    });

    if (upcNotFound.length > 0) {
      debug(`albums UPC not found: ${upcNotFound.length}`);

      debug(`will search for arist, album title matches`);

      const titleIndex = header.indexOf("title");
      const artistIndex = header.indexOf("artist");

      const notFound: string[][] = [];

      upcNotFound.forEach((row) => {
        const album = Object.values(library.albums).find(
          (album) =>
            album.name === row[titleIndex] &&
            album.artists[0].name === row[artistIndex]
        );
        if (album) {
          debug(`Found album ${album.external_ids.upc}`);
          if (dateAddedIndex !== -1) {
            album.addedDate = row[dateAddedIndex];
            debug(`Overwritting addedDate to ${row[dateAddedIndex]}`);
          }
        } else {
          notFound.push(row);
        }
      });

      if (notFound.length > 0) {
        debug(`WARNING albums not found: ${notFound.length}`);
        console.log(notFound);
      }
    }

    await save();
  }

  const cleanLibrary = await clean();

  debug("saving cleaned library file");

  await writeFile(
    "/home/nfs/code/movie-browser/public/lib-music.json",
    JSON.stringify(cleanLibrary),
    undefined,
    debug
  );
}

init();

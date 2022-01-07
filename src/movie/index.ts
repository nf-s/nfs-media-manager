require("dotenv").config();

import { debug as debugInit } from "debug";
import { Movie as OMDBMovie } from "imdb-api";
import { MovieResponse as TMDBMovie } from "moviedb-promise/dist/request-types";
import { default as PTPMovie } from "nfs-passthepopcorn/lib/objects/movie";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs";
import { skip } from "../util/skip";
import { clean } from "./clean";
import scrapeMovie from "./scrape";
import myImdbRatings from "./scrape/imdb-ratings";
import scanNfos from "./scrape/nfo";
import { PtpMovieScrape } from "./scrape/ptp";

export interface Movie {
  id?: { imdb?: string; tmdb?: string; ptp?: number };
  title?: string;
  originalTitle?: string;
  /** Raw dump from NFO file */
  raw?: any;
  tmdb?: TMDBMovie | null;
  omdb?: OMDBMovie | null;
  imdb?: { myRating: { value: number; date: string } };
  ptp?: PTPMovie | null;
  ptpScrape?: PtpMovieScrape | null;
}

export interface Library {
  nfoFiles: string[];
  /** NFO files which failed to parse */
  failedNfos: string[];
  movies: { [file: string]: Movie };
}

const debug = debugInit("movie-scraper:init");

debug("HELLO!");

// SETUP data directories
if (typeof process.env.DATA_DIR === "undefined")
  throw "DATA_DIR must be set to a valid directory";

// SETUP library JSON blob
export const LIBRARY_PATH = join(process.env.DATA_DIR, "lib.json");

export const library: Library = {
  nfoFiles: [],
  failedNfos: [],
  movies: {},
};

export async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

async function init() {
  // Load library
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nreading...`);
    Object.assign(library, await readJSONFile(LIBRARY_PATH, debug));

    debug(`library has ${library.nfoFiles.length} NFO files`);

    debug(`Backing up lib to ${LIBRARY_PATH}-backup`);
    await writeFile(
      `${LIBRARY_PATH}-backup`,
      JSON.stringify(library),
      undefined,
      debug
    );
  }

  if (!skip("nfo")) await scanNfos();

  if (!skip("movie")) await scrapeMovie();

  if (!skip("imdb")) await myImdbRatings();

  if (!skip("clean") && process.env.MOVIE_CLEAN_JSON) {
    const cleanLibrary = await clean();

    debug("saving cleaned library file");

    await writeFile(
      process.env.MOVIE_CLEAN_JSON,
      JSON.stringify(cleanLibrary),
      undefined,
      debug
    );
  }
}

init();

require("dotenv").config();

import { debug as debugInit } from "debug";
import { join } from "path";
import { clean } from "./clean";
import { Library } from "./interfaces";
import scanNfos from "./scrape/nfo";
import scrapeMovie from "./scrape";
import myImdbRatings from "./scrape/imdb-ratings";
import { fileExists, readJSONFile, writeFile } from "../util/fs";

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
  }

  await scanNfos();

  await scrapeMovie();

  await myImdbRatings();

  const cleanLibrary = await clean();

  debug("saving cleaned library file");

  await writeFile(
    "/home/nfs/code/movie-browser/public/lib.json",
    JSON.stringify(cleanLibrary),
    undefined,
    debug
  );
}

init();

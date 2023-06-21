import debugPkg from "debug";
import dotenv from "dotenv";
import { Movie as OMDBMovie } from "imdb-api";
import { MovieResponse as TMDBMovie } from "moviedb-promise/dist/request-types.js";
import type PTPMovie from "nfs-passthepopcorn/lib/objects/movie.js";
import { join } from "path";
import { fileExists, readJSONFile, writeFile } from "../util/fs.js";
import { skip } from "../util/skip.js";
import { clean } from "./clean.js";
import myImdbRatings from "./scrape/imdb-ratings.js";
import myImdbWatchlist from "./scrape/imdb-watchlist.js";
import scanNfos from "./scrape/nfo.js";
import scrapeOmdb from "./scrape/omdb.js";
import ptpBookmarks from "./scrape/ptp-bookmarks.js";
import scrapePtp, { PtpMovieScrape } from "./scrape/ptp.js";
import scrapeTmdb from "./scrape/tmdb.js";

dotenv.config();

export interface Movie {
  id?: { imdb?: string; tmdb?: string; ptp?: number };
  title?: string;
  originalTitle?: string;
  /** Raw dump from NFO file */
  raw?: any;
  tmdb?: TMDBMovie | null;
  omdb?: OMDBMovie | null;
  imdb?: {
    myRating?: { value: number; date: string };
    myWatchlist?: { date: string };
  };
  ptp?: PTPMovie.default | null;
  ptpBookmark?: { date: string };
  ptpScrape?: PtpMovieScrape | null;
  owned?: { type: "bluray"; date?: string };
  file?: { nfoPath: string; date: string };
}

export interface Library {
  nfoFiles: string[];
  /** NFO files which failed to parse */
  failedNfos: string[];
  movies: { [fileOrImdbId: string]: Movie };
}

const debug = debugPkg.debug("movie-scraper:init");

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

async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

export async function run() {
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

  /*

Owned to fix

Should be bluray
- What Have I Done to Deserve This? (is imdb-rating)


Should be imdb-watchlist
- Belle
- After Yang
- Great Freedom
- Ascension


*/
  try {
    if (!skip("nfo")) await scanNfos();
    if (!skip("imdb-ratings")) await myImdbRatings();
    if (!skip("imdb-watchlist")) await myImdbWatchlist();
    if (!skip("ptp-bookmarks")) await ptpBookmarks();
  } catch (e) {
    debug(e);
    debug("ERROR occurred while scraping new movies");
  }

  await save();

  // These can all be done in parallel
  try {
    await Promise.all([
      !skip("ptp") ? scrapePtp() : Promise.resolve(),
      !skip("omdb") ? scrapeOmdb() : Promise.resolve(),
      !skip("tmdb") ? scrapeTmdb() : Promise.resolve(),
    ]);
  } catch (e) {
    debug(e);
    debug("ERROR occurred while scraping metadata for movies");
  }

  await save();

  // Calculate how many movies have NO metadata
  const notFound = Object.values(library.movies).filter(
    (movie) => !(movie.omdb || movie.tmdb || movie.ptp)
  );

  debug(
    `library is missing metadata for ${notFound.length}/${
      Object.entries(library.movies).length
    } (${
      (notFound.length * 100) / Object.entries(library.movies).length
    }%) found`
  );

  debug(
    notFound.map(
      (movie) => movie.raw?.movie?.title?.[0] ?? movie.id?.imdb ?? "OMG WHAT"
    )
  );

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

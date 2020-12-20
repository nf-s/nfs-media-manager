require("dotenv").config();

import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { Client as OMDBClient, Movie as OMDBMovie } from "imdb-api";
import { MovieDb as TMDBClient } from "moviedb-promise";
import { MovieResponse as TMDBMovie } from "moviedb-promise/dist/request-types";
import { join, parse } from "path";
import {
  fileExists,
  forEachFileInDir,
  loadXml,
  readJSONFile,
  writeFile,
} from "./util/fs";

const debug = debugInit("movie-scraper:init");

debug("HELLO!");

// SETUP data directories
if (typeof process.env.DATA_DIR === "undefined")
  throw "DATA_DIR must be set to a valid directory";

// SETUP library JSON blob
const LIBRARY_PATH = join(process.env.DATA_DIR, "lib.json");
type Movie = {
  id?: { imdb?: string; tmdb?: string };
  /** Raw dump from NFO file */
  raw?: any;
  tmdb?: TMDBMovie | null;
  omdb?: OMDBMovie | null;
};
let library: {
  nfoFiles: string[];
  /** NFO files which failed to parse */
  failedNfos: string[];
  movies: { [file: string]: Movie };
} = {
  nfoFiles: [],
  failedNfos: [],
  movies: {},
};

async function init() {
  // Load library
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nreading...`);
    library = Object.assign(library, await readJSONFile(LIBRARY_PATH, debug));

    debug(`library has ${library.nfoFiles.length} NFO files`);
  }

  // Scan directory for NFO files
  if (typeof process.env.SCAN_DIR === "string") {
    debug(`scanning directory ${process.env.SCAN_DIR}...`);
    await forEachFileInDir(
      process.env.SCAN_DIR,
      async (file) => {
        const filePath = parse(file);
        // Filter only nfos, and remove paths which partially include SCAN_EXCLUDE values
        if (
          filePath.ext === ".nfo" &&
          !library.nfoFiles.includes(file) &&
          (process.env.SCAN_EXCLUDE
            ? !process.env.SCAN_EXCLUDE.split(",").reduce(
                (found, exclude) => found || file.includes(exclude),
                false
              )
            : true)
        ) {
          library.nfoFiles.push(file);
          debug(`found ${file}`);
        }
      },
      undefined,
      true,
      undefined,
      debug
    );

    debug(`writing library file to ${LIBRARY_PATH}`);
    await save();
  }

  // Make sure we have JSON for all NFO files
  debug(`checking for new NFO files...`);
  await Promise.all(
    library.nfoFiles
      // Filter movies which haven't been loaded
      .filter((file) => !library.movies[file])
      .map(async (file) => {
        debug(`found new NFO: ${file}`);
        try {
          const xml = await loadXml(file, debug);
          library.movies[file] = { raw: xml };
        } catch (error) {
          debug(`FAILED to parse NFO: ${file}`);
          debug(error);
          library.failedNfos.push(file);
        }
      })
  );

  library.failedNfos = Array.from(new Set(library.failedNfos));

  // Filter out failed NFO files
  library.nfoFiles = library.nfoFiles.filter(
    (file) => !library.failedNfos.includes(file)
  );

  debug(`library has ${library.failedNfos.length} failed NFOs`);
  debug(library.failedNfos);

  debug(`process NFOs`);

  let found = 0;

  // Get IDS for movies (from NFO raw JSON)
  Object.entries(library.movies).forEach(([file, value]) => {
    const movie = value;

    let id = movie.id;

    if (typeof id === "undefined") {
      id = {};
    }

    // Try to get IMDB id
    if (typeof id.imdb === "undefined") {
      const imdbId =
        movie.raw?.movie?.id?.[0] ||
        movie.raw?.movie?.uniqueid?.find((id: any) => id["$"].type === "imdb")
          ?._;
      if (imdbId && imdbId !== "") {
        id.imdb = imdbId;
        debug(`found IMBD ID ${imdbId}`);
      }
    }

    // Try to get TMDB id
    if (typeof id.tmdb === "undefined") {
      const tmdbId =
        movie.raw?.movie?.tmdbId?.[0] ||
        movie.raw?.movie?.uniqueid?.find((id: any) => id["$"].type === "tmdb")
          ?._;
      if (tmdbId && tmdbId !== "") {
        id.tmdb = tmdbId;
        debug(`found TMDB ID ${tmdbId}`);
      }
    }

    movie.id = id;

    if (!id.imdb && !id.tmdb) {
      debug(`FAILED to ID movie ${file}`);
    } else {
      found++;
    }
  });

  debug(
    `library has found IDs for ${found}/${
      Object.entries(library.movies).length
    } (${(found * 100) / Object.entries(library.movies).length}%) found`
  );

  await save();

  // GET TMDB THINGS!
  if (process.env.TMDB_API_KEY) {
    const tmdbClient = new TMDBClient(process.env.TMDB_API_KEY);
    debug(`connected to TMDB!`);

    const tmdbLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 333,
    });

    await Promise.all(
      Object.values(library.movies)
        // Filter movies which have no TMDB metadata and have TMDB id
        .filter((movie) => movie.id?.tmdb && !movie.tmdb && movie.tmdb !== null)
        .map((movie) =>
          tmdbLimiter.schedule(async () => {
            debug(`fetching TMDB ${movie.id?.tmdb}`);
            try {
              const response = await tmdbClient!.movieInfo({
                id: movie.id?.tmdb!,
              });
              movie.tmdb = response;
              debug(`SUCCESSFULLY fetched TMDB ${movie.id?.tmdb}`);
            } catch (error) {
              debug(`FAILED to fetched TMDB ${movie.id?.tmdb}`);
              debug(error);
              movie.tmdb = null;
            }
          })
        )
    );
    await save();
  } else {
    debug(`WARNING, no TMDB_API_KEY has been set`);
  }

  // Calculate how many movies have TMDB metadata
  const tmdbFound = Object.values(library.movies).filter((movie) => movie.tmdb)
    .length;

  debug(
    `library has TMDB metadata for ${tmdbFound}/${
      Object.entries(library.movies).length
    } (${(tmdbFound * 100) / Object.entries(library.movies).length}%) found`
  );

  // GET OMDB THINGS!
  if (process.env.OMDB_API_KEY) {
    debug(`connected to OMDB!`);

    const omdbClient = new OMDBClient({ apiKey: process.env.OMDB_API_KEY });

    const obdmLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1000,
    });

    await Promise.all(
      Object.values(library.movies)
        // Filter movies which have no OMDB metadata and have IMDB id
        .filter((movie) => movie.id?.imdb && !movie.omdb && movie.omdb !== null)
        .map((movie) =>
          obdmLimiter.schedule(async () => {
            debug(`fetching OMDB ${movie.id?.imdb}`);
            try {
              const response = await omdbClient.get({ id: movie.id?.imdb });
              movie.omdb = response;
              debug(`SUCCESSFULLY fetched OMDB ${movie.id?.imdb}`);
            } catch (error) {
              debug(`FAILED to fetched OMDB ${movie.id?.imdb}`);
              debug(error);
              movie.omdb = null;
            }
          })
        )
    );

    await save();
  } else {
    debug(`WARNING no OMDB_API_KEY has been set`);
  }

  // Calculate how many movies have OMDB metadata
  const omdbFound = Object.values(library.movies).filter((movie) => movie.omdb)
    .length;

  debug(
    `library has OMDB metadata for ${omdbFound}/${
      Object.entries(library.movies).length
    } (${(omdbFound * 100) / Object.entries(library.movies).length}%) found`
  );

  // Calculate how many movies have NO metadata
  const notFound = Object.values(library.movies).filter(
    (movie) => !(movie.omdb || movie.tmdb)
  );

  debug(
    `library is missing metadata for ${notFound.length}/${
      Object.entries(library.movies).length
    } (${
      (notFound.length * 100) / Object.entries(library.movies).length
    }%) found`
  );

  debug(notFound.map((movie) => movie.raw?.movie?.title?.[0]));
}

async function save() {
  await writeFile(LIBRARY_PATH, JSON.stringify(library), undefined, debug);
}

init();

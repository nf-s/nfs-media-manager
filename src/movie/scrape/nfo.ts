import { debug as debugInit } from "debug";
import { parse } from "path";
import { library, LIBRARY_PATH, save } from "../";
import { forEachFileInDir, loadXml } from "../../util/fs";

const debug = debugInit("movie-scraper:nfo-scraper");

export default async function scanNfos() {
  // Scan directory for NFO files
  if (typeof process.env.SCAN_DIR === "string") {
    debug(`scanning directory ${process.env.SCAN_DIR}...`);
    await forEachFileInDir(
      process.env.SCAN_DIR!,
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
  } else {
    debug(`WARNING SCAN_DIR is undefined - not scanning directory for NFOs`);
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

    // Get title and original title
    movie.title = movie.raw?.movie?.title?.[0];
    const originalTitle = movie.raw?.movie?.originaltitle?.[0];
    if (typeof originalTitle === "string" && movie.title !== originalTitle) {
      movie.originalTitle = originalTitle;
    }
  });

  debug(
    `library has found IDs for ${found}/${
      Object.entries(library.movies).length
    } (${(found * 100) / Object.entries(library.movies).length}%) found`
  );

  await save();
}

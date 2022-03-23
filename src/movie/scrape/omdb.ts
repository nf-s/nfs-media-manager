import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { Client as OMDBClient } from "imdb-api";
import { library } from "..";

const debug = debugInit("movie-scraper:scrape-omdb");

export default async function scrapeOmdb() {
  // GET OMDB THINGS!
  if (process.env.OMDB_API_KEY) {
    const omdbClient = new OMDBClient({ apiKey: process.env.OMDB_API_KEY });
    debug(`connected to OMDB!`);

    const omdbLimiter = new Bottleneck({
      maxConcurrent: 5,
      minTime: 200,
    });

    const omdbToFind = Object.values(library.movies)
      // Filter movies which have no OMDB metadata and have IMDB id
      .filter((movie) => movie.id?.imdb && !movie.omdb && movie.omdb !== null);
    let counter = 0;

    await Promise.all(
      omdbToFind.map((movie) =>
        omdbLimiter.schedule(async () => {
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
          counter++;
          debug(`DONE ${(counter * 100) / omdbToFind.length}%`);
        })
      )
    );
  } else {
    debug(`WARNING no OMDB_API_KEY has been set`);
  }

  // Calculate how many movies have OMDB metadata
  const omdbFound = Object.values(library.movies).filter(
    (movie) => movie.omdb
  ).length;

  debug(
    `library has OMDB metadata for ${omdbFound}/${
      Object.entries(library.movies).length
    } (${(omdbFound * 100) / Object.entries(library.movies).length}%) found`
  );
}

import Bottleneck from "bottleneck";
import debugPkg from "debug";
import { MovieDb as TMDBClient } from "moviedb-promise";
import { ExternalId } from "moviedb-promise/dist/request-types.js";
import { library } from "../index.js";

const debug = debugPkg.debug("movie-scraper:scrape-tmdb");

export default async function scrapeTmdb() {
  // GET TMDB THINGS!
  if (process.env.TMDB_API_KEY) {
    const tmdbClient = new TMDBClient(process.env.TMDB_API_KEY!);
    debug(`connected to TMDB!`);

    const tmdbLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 333,
    });

    const tmdbToFind = Object.values(library.movies)
      // Filter movies which have no TMDB metadata and have TMDB id
      .filter(
        (movie) =>
          (movie.id?.tmdb || movie.id?.imdb) &&
          !movie.tmdb &&
          movie.tmdb !== null
      );
    let counter = 0;

    await Promise.all(
      tmdbToFind.map((movie) =>
        tmdbLimiter.schedule(async () => {
          try {
            if (typeof movie.id!.tmdb === "string") {
              debug(`fetching TMDB ${movie.id?.tmdb}`);
              const response = await tmdbClient!.movieInfo({
                id: movie.id!.tmdb!,
              });
              movie.tmdb = response;
              debug(`SUCCESSFULLY fetched TMDB ${movie.id?.tmdb}`);
            } else if (typeof movie.id!.imdb === "string") {
              debug(`fetching TMDB by IMDB id ${movie.id?.imdb}`);
              const response = await tmdbClient!.find({
                id: movie.id!.imdb!,
                external_source: ExternalId.ImdbId,
              });

              if (response.movie_results.length > 0) {
                movie.tmdb = response.movie_results[0];
                debug(
                  `SUCCESSFULLY fetched TMDB from IMDB id ${movie.id?.imdb}`
                );
              }
            }

            if (!movie.tmdb) {
              debug(`FAILED to fetched TMDB ${movie.id?.tmdb}`);
              movie.tmdb = null;
            }
          } catch (error) {
            debug(`FAILED to fetched TMDB ${movie.id?.tmdb}`);
            debug(error);
            movie.tmdb = null;
          }
          counter++;
          debug(`DONE ${(counter * 100) / tmdbToFind.length}%`);
        })
      )
    );
  } else {
    debug(`WARNING, no TMDB_API_KEY has been set`);
  }

  // Calculate how many movies have TMDB metadata
  const tmdbFound = Object.values(library.movies).filter(
    (movie) => movie.tmdb
  ).length;

  debug(
    `library has TMDB metadata for ${tmdbFound}/${
      Object.entries(library.movies).length
    } (${(tmdbFound * 100) / Object.entries(library.movies).length}%) found`
  );
}

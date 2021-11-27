import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { Client as OMDBClient } from "imdb-api";
import { MovieDb as TMDBClient } from "moviedb-promise";

import { join } from "path";
import { library, save } from "..";

import { writeFile } from "../../util/fs";

const debug = debugInit("movie-scraper:scrape");

export default async function scrapeMovie() {
  // GET TMDB THINGS!
  if (process.env.TMDB_API_KEY) {
    const tmdbClient = new TMDBClient(process.env.TMDB_API_KEY!);
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
  const tmdbFound = Object.values(library.movies).filter(
    (movie) => movie.tmdb
  ).length;

  debug(
    `library has TMDB metadata for ${tmdbFound}/${
      Object.entries(library.movies).length
    } (${(tmdbFound * 100) / Object.entries(library.movies).length}%) found`
  );

  // GET OMDB THINGS!
  if (process.env.OMDB_API_KEY) {
    const omdbClient = new OMDBClient({ apiKey: process.env.OMDB_API_KEY });
    debug(`connected to OMDB!`);

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
  const omdbFound = Object.values(library.movies).filter(
    (movie) => movie.omdb
  ).length;

  debug(
    `library has OMDB metadata for ${omdbFound}/${
      Object.entries(library.movies).length
    } (${(omdbFound * 100) / Object.entries(library.movies).length}%) found`
  );








    );


      maxConcurrent: 1,
      minTime: 2000,
    });

    await Promise.all(
      Object.values(library.movies)


        .map((movie) =>


            try {




            } catch (error) {

              debug(error);

            }
          })
        )
    );



    await Promise.all(
      Object.values(library.movies)

        .filter(
          (movie) =>

        )
        .map((movie) =>


            try {


              );

              // Note - no need to await this
              writeFile(
                join(
                  process.env.DATA_DIR!,
                  "scrape",


                ),
                response
              ).catch((e) => {

                console.log(e);
              });






            } catch (error) {

              debug(error);

            }
          })
        )
    );

    await save();
  } else {

  }




  ).length;

  debug(

      Object.entries(library.movies).length

  );




  ).length;

  debug(

      Object.entries(library.movies).length
    } (${

    }%) found`
  );

  // Calculate how many movies have NO metadata
  const notFound = Object.values(library.movies).filter(

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

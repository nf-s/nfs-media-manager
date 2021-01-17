import { debug as debugInit } from "debug";
import { library, save } from "..";
import { readCsv } from "../../util/fs";

const debug = debugInit("movie-scraper:my-imdb-ratings");

export default async function myImdbRatings() {
  if (typeof process.env.IMDB_RATINGS_CSV === "undefined") {
    debug(`WARNING, no IMDB_RATINGS_CSV has been set`);
    return;
  }

  debug(`reading IMDB CSV to find personal ratings`);

  try {
    const csv = await readCsv(process.env.IMDB_RATINGS_CSV);
    csv.forEach((row) => {
      if (row[0].startsWith("tt")) {
        const movie = Object.values(library.movies).find(
          (movie) => movie.id?.imdb === row[0]
        );
        if (movie) {
          if (!movie.imdb || movie.imdb.myRating.date !== row[2]) {
            debug(`found personal IMDB rating form ${row[0]}`);
            movie.imdb = {
              myRating: { value: parseFloat(row[1]), date: row[2] },
            };
          }
        }
      }
    });
  } catch (error) {
    debug(`FAILED to get IMDB ratings from IMDB csv`);
    debug(error);
  }

  await save();
}

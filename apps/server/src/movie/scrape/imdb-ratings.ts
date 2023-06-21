import debugPkg from "debug";
import { library } from "../index.js";
import { readCsv } from "../../util/fs.js";

const debug = debugPkg.debug("movie-scraper:my-imdb-ratings");

export default async function myImdbRatings() {
  if (typeof process.env.IMDB_RATINGS_CSV === "undefined") {
    debug(`WARNING, no IMDB_RATINGS_CSV has been set`);
    return;
  }

  debug(`reading IMDB CSV to find personal ratings`);

  try {
    const csv = await readCsv(process.env.IMDB_RATINGS_CSV);
    csv.forEach((row) => {
      const id = row[0];
      if (id.startsWith("tt")) {
        let movie = Object.values(library.movies).find(
          (m) => m.id?.imdb === id
        );
        if (!movie) {
          movie = { id: { imdb: id } };
          library.movies[id] = movie;
        }

        if (!movie.imdb?.myRating) {
          if (!movie.imdb) {
            movie.imdb = {};
          }
          debug(`found personal IMDB rating form ${row[0]}`);
          movie.imdb = {
            myRating: { value: parseFloat(row[1]), date: row[2] },
          };
        }
      }
    });
  } catch (error) {
    debug(`FAILED to get IMDB ratings from IMDB csv`);
    debug(error);
  }
}

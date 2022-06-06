import { debug as debugInit } from "debug";
import { library } from "..";
import { readCsv } from "../../util/fs";

const debug = debugInit("movie-scraper:my-imdb-watchlist");

export default async function myImdbWatchlist() {
  if (typeof process.env.IMDB_WATCHLIST_CSV === "undefined") {
    debug(`WARNING, no IMDB_WATCHLIST_CSV has been set`);
    return;
  }

  debug(`reading IMDB CSV to find personal watchlist`);

  try {
    const csv = await readCsv(process.env.IMDB_WATCHLIST_CSV);
    csv.forEach((row) => {
      const id = row[1];
      if (id.startsWith("tt")) {
        let movie = Object.values(library.movies).find(
          (movie) => movie.id?.imdb === id
        );
        if (!movie) {
          movie = { id: { imdb: id } };
          library.movies[id] = movie;
        }

        if (!movie.imdb?.myWatchlist) {
          if (!movie.imdb) {
            movie.imdb = {};
            movie.owned = { type: 'bluray' }
          }
          movie.imdb.myWatchlist = { date: row[2] };
          debug(`found personal IMDB watchlist from ${id}`);
        }
      }
    });
  } catch (error) {
    debug(`FAILED to get IMDB watchlist from IMDB csv`);
    debug(error);
  }
}

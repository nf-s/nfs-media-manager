import debugPkg from "debug";
import { library } from "../index.js";
import { readCsv } from "../../util/fs.js";

const debug = debugPkg.debug("movie-scraper:ptp-bookmarks");

export default async function ptpBookmarks() {
  if (typeof process.env.PTP_BOOKMARKS_CSV === "undefined") {
    debug(`WARNING, no PTP_BOOKMARKS_CSV has been set`);
    return;
  }

  debug(`reading PTP Bookmarks CSV`);

  try {
    const csv = await readCsv(process.env.PTP_BOOKMARKS_CSV);
    csv.forEach((row) => {
      const match = /http:\/\/www\.imdb\.com\/title\/([a-zA-Z0-9]+)\//g.exec(
        row[2]
      );
      const id = match?.[1];

      if (id && id.startsWith("tt")) {
        let movie = Object.values(library.movies).find(
          (movie) => movie.id?.imdb === id
        );
        if (!movie) {
          movie = { id: { imdb: id } };
          library.movies[id] = movie;
        }

        if (!movie.ptpBookmark) {
          movie.ptpBookmark = { date: row[3] };
          debug(`found PTP Bookmark from ${id}`);
        }
      } else {
        debug(`FAILED to identify IMDB id from row ${row.join(", ")}`);
        debug(match);
      }
    });
  } catch (error) {
    debug(`FAILED to get PTP Bookmarks from csv`);
    debug(error);
  }
}

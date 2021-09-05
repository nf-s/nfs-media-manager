import { debug as debugInit } from "debug";
import { library, Source } from "..";
import { fileExists, readCsv } from "../../util/fs";
import { searchSpotify } from "./spotify";
const debug = debugInit("music-scraper:album-csv");

export async function albumCsv() {
  if (process.env.ALBUM_CSV && (await fileExists(process.env.ALBUM_CSV))) {
    debug(`Importing CSV with Albums`);

    const csv = await readCsv(
      process.env.ALBUM_CSV,
      process.env.ALBUM_CSV_DELIMITER
    );

    const header = csv.splice(0, 1)[0];

    const titleIndex = header.indexOf(process.env.ALBUM_TITLE_COL ?? "title");
    const artistIndex = header.indexOf(
      process.env.ALBUM_ARTIST_COL ?? "artist"
    );
    const addedDateIndex = header.indexOf(
      process.env.ALBUM_DATE_ADDED_COL ?? "date"
    );

    const rowsToSearch: Source[] = [];

    let updatedAlbums = 0;

    debug(`found ${csv.length} rows`);

    csv.forEach((row) => {
      const title = row[titleIndex].trim().toLowerCase();
      const artist = row[artistIndex].trim().toLowerCase();
      const addedDate = row[addedDateIndex];
      // Are there any matches with existing albums?
      // By artist/title string matchiing
      const album = Object.values(library.albums).find(
        (a) =>
          a.spotify.name.trim().toLowerCase() === title &&
          a.spotify.artists.find(
            (ar) => ar.name.trim().toLowerCase() === artist
          )
      );
      if (album) {
        debug(`Matched album ${artist} - ${title}`);
        updatedAlbums += 1;
        if (
          addedDateIndex !== -1 &&
          typeof addedDate !== "undefined" &&
          new Date(addedDate) < new Date(album.spotify.addedDate)
        ) {
          album.spotify.addedDate = addedDate;
          debug(`Overwritting addedDate to ${addedDate}`);
        }
      } else {
        rowsToSearch.push({
          title,
          artist,
          addedDate,
          type: "album_csv",
          filename: process.env.ALBUM_CSV!,
        });
      }
    });

    debug(`updated ${updatedAlbums} existing albums from CSV`);

    if (rowsToSearch.length > 0) {
      debug(`rows to search for: ${rowsToSearch.length}`);

      await searchSpotify(rowsToSearch);
    }
  }
}

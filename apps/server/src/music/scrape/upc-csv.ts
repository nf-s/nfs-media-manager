import debugPkg from "debug";
import { library, Source } from "../index.js";
import { fileExists, readCsv } from "../../util/fs.js";
import { searchSpotify } from "./spotify.js";
import SpotifyWebApi from "spotify-web-api-node";
const debug = debugPkg.debug("music-scraper:upc-csv");

export async function upcCsv(spotifyApi: SpotifyWebApi) {
  if (process.env.UPC_CSV && (await fileExists(process.env.UPC_CSV))) {
    debug(`Importing CSV with UPCs`);

    const csv = await readCsv(
      process.env.UPC_CSV,
      process.env.UPC_CSV_DELIMITER
    );

    const header = csv.splice(0, 1)[0];

    const upcIndex = header.indexOf("upc");
    const addedDateIndex = header.indexOf("addedDate");
    const titleIndex = header.indexOf("title");
    const artistIndex = header.indexOf("artist");

    const upcNotFound: string[][] = [];

    csv.forEach((row) => {
      const album = Object.values(library.albums).find(
        (a) =>
          a.spotify.external_ids.upc &&
          a.spotify.external_ids.upc === row[upcIndex]
      );
      if (album) {
        debug(`Found album ${album.spotify.external_ids.upc}`);
        if (
          addedDateIndex !== -1 &&
          typeof row[addedDateIndex] !== "undefined" &&
          new Date(row[addedDateIndex]) < new Date(album.spotify.addedDate)
        ) {
          album.spotify.addedDate = row[addedDateIndex];
          debug(`Overwritting addedDate to ${row[addedDateIndex]}`);
        }
      } else {
        upcNotFound.push(row);
      }
    });

    if (upcNotFound.length > 0) {
      debug(`albums UPC not found: ${upcNotFound.length}`);

      debug(`will search for arist, album title matches`);

      const rowsToSearch: Source[] = [];

      let updatedAlbums = 0;

      upcNotFound.forEach((row) => {
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
          if (
            addedDateIndex !== -1 &&
            typeof addedDate !== "undefined" &&
            new Date(addedDate) < new Date(album.spotify.addedDate)
          ) {
            updatedAlbums += 1;
            album.spotify.addedDate = addedDate;
            debug(`Overwritting addedDate to ${addedDate}`);
          }
        } else {
          rowsToSearch.push({
            title,
            artist,
            addedDate,
            type: "upc_csv",
            upc: row[upcIndex],
            filename: process.env.UPC_CSV!,
          });
        }
      });

      debug(`updated ${updatedAlbums} existing albums from CSV`);

      if (rowsToSearch.length > 0) {
        debug(`rows to search for: ${rowsToSearch.length}`);

        await searchSpotify(spotifyApi, rowsToSearch);
      }
    }
  }
}

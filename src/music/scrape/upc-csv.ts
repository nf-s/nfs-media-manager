import { debug as debugInit } from "debug";
import { library, save } from "..";
import { fileExists, readCsv } from "../../util/fs";
const debug = debugInit("music-scraper:upc-csv");

export async function upcCsv() {
  if (process.env.UPC_CSV && (await fileExists(process.env.UPC_CSV))) {
    debug(`Importing CSV with UPCs`);

    const csv = await readCsv(
      process.env.UPC_CSV,
      process.env.UPC_CSV_DELIMITER
    );

    const header = csv.splice(0, 1)[0];

    const upcIndex = header.indexOf("upc");
    const dateAddedIndex = header.indexOf("addedDate");

    const upcNotFound: string[][] = [];

    csv.forEach((row) => {
      const album = Object.values(library.albums).find(
        (album) =>
          album.spotify.external_ids.upc &&
          album.spotify.external_ids.upc === row[upcIndex]
      );
      if (album) {
        debug(`Found album ${album.spotify.external_ids.upc}`);
        if (dateAddedIndex !== -1) {
          album.spotify.addedDate = row[dateAddedIndex];
          debug(`Overwritting addedDate to ${row[dateAddedIndex]}`);
        }
      } else {
        upcNotFound.push(row);
      }
    });

    if (upcNotFound.length > 0) {
      debug(`albums UPC not found: ${upcNotFound.length}`);

      debug(`will search for arist, album title matches`);

      const titleIndex = header.indexOf("title");
      const artistIndex = header.indexOf("artist");

      const notFound: string[][] = [];

      upcNotFound.forEach((row) => {
        const album = Object.values(library.albums).find(
          (album) =>
            album.spotify.name === row[titleIndex] &&
            album.spotify.artists[0].name === row[artistIndex]
        );
        if (album) {
          debug(`Found album ${album.spotify.external_ids.upc}`);
          if (dateAddedIndex !== -1) {
            album.spotify.addedDate = row[dateAddedIndex];
            debug(`Overwritting addedDate to ${row[dateAddedIndex]}`);
          }
        } else {
          notFound.push(row);
        }
      });

      if (notFound.length > 0) {
        debug(`WARNING albums not found: ${notFound.length}`);
        console.log(notFound);
      }
    }

    await save();
  }
}

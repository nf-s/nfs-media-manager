import Bottleneck from "bottleneck";
import { load } from "cheerio";
import { debug as debugInit } from "debug";
import { default as PTPClient } from "nfs-passthepopcorn/lib/api";
import { join } from "path";
import { library } from "..";
import { writeFile } from "../../util/fs";

const debug = debugInit("movie-scraper:scrape-ptp");

export default async function scrapePtp() {
  // GET PTP THINGS!
  if (process.env.PTP_API_USER && process.env.PTP_API_KEY) {
    debug(`connected to PTP!`);

    const ptpClient = new PTPClient(
      process.env.PTP_API_USER!,
      process.env.PTP_API_KEY!
    );

    const ptpLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 2000,
    });

    const ptpToFind = Object.values(library.movies)
      // Filter movies which have no PTP metadata and have IMDB id
      .filter((movie) => movie.id?.imdb && !movie.ptp && movie.ptp !== null);

    let counter = 0;
    await Promise.all(
      ptpToFind.map((movie) =>
        ptpLimiter.schedule(async () => {
          debug(`fetching PTP ${movie.id?.imdb}`);
          try {
            const response = await ptpClient.searchByImdbId(movie.id?.imdb!);

            if (response) {
              movie.id!.ptp = response.id;
              movie.ptp = response;
              debug(`SUCCESSFULLY fetched PTP ${movie.id?.imdb}`);
            } else {
              debug(`FAILED to fetched PTP ${movie.id?.imdb}`);
              movie.ptp = null;
            }
          } catch (error) {
            debug(`FAILED to fetched PTP ${movie.id?.imdb}`);
            debug(error);
            movie.ptp = null;
          }
          counter++;
          debug(`DONE ${(counter * 100) / ptpToFind.length}%`);
        })
      )
    );

    debug("scraping PTP HTML data");

    const ptpHtmlToScrape = Object.values(library.movies)
      // Filter movies which have no PTP SCRAPE metadata and have PTP id
      .filter(
        (movie) => movie.id?.ptp && !movie.ptpScrape && movie.ptpScrape !== null
      );
    counter = 0;

    await Promise.all(
      ptpHtmlToScrape.map((movie) =>
        ptpLimiter.schedule(async () => {
          debug(`fetching PTP HTML ${movie.id!.ptp}`);
          try {
            const response = await ptpClient.connection.getText(
              `torrents.php?id=${movie.id!.ptp}&json=0`
            );

            // Note - no need to await this
            writeFile(
              join(
                process.env.DATA_DIR!,
                "scrape",
                "ptp",
                `${movie.id!.ptp}.html`
              ),
              response
            ).catch((e) => {
              debug(`FAILED to save PTP HTML response to file`);
              debug(e);
            });

            const ptpScrapeData = htmlParse(response);

            movie.ptpScrape = ptpScrapeData;
            debug(`SUCCESSFULLY fetched PTP HTML ${movie.id?.ptp}`);
          } catch (error) {
            debug(`FAILED to fetched PTP HTML ${movie.id?.ptp}`);
            debug(error);
            movie.ptpScrape = null;
          }
          counter++;
          debug(`DONE ${(counter * 100) / ptpHtmlToScrape.length}%`);
        })
      )
    );
  } else {
    debug(`WARNING no PTP_API_USER and PTP_API_KEY have been set`);
  }

  // Calculate how many movies have PTP metadata
  const ptpFound = Object.values(library.movies).filter(
    (movie) => movie.ptp
  ).length;

  debug(
    `library has PTP metadata for ${ptpFound}/${
      Object.entries(library.movies).length
    } (${(ptpFound * 100) / Object.entries(library.movies).length}%) found`
  );

  // Calculate how many movies have PTP metadata
  const ptpScrapeFound = Object.values(library.movies).filter(
    (movie) => movie.ptpScrape
  ).length;

  debug(
    `library has PTP scrape metadata for ${ptpScrapeFound}/${
      Object.entries(library.movies).length
    } (${
      (ptpScrapeFound * 100) / Object.entries(library.movies).length
    }%) found`
  );
}

export interface PtpMovieScrape {
  tags: string[];
  collections: { id: number; name: string; spoiler: boolean; length: number }[];
  similar: number[];
  rating: { value: number; votes: number };
}

function htmlParse(html: string): PtpMovieScrape {
  const $ = load(html);
  const tags: string[] = $(`.box_tags li a[href^="torrents.php?taglist="]`)
    .toArray()
    .map((e) => (e.firstChild as any).data);

  const collections = $(
    `#collages #detailsCollections li a[href^="collages.php?id="]`
  )
    .toArray()
    .map((e) => {
      return {
        id: parseInt(e.attribs.href.split("id=")[1]),
        name: (e.firstChild as any).data as string,
        length: parseInt(
          ((e.parent?.lastChild as any).data as string).substr(2).split(")")[0]
        ),
        spoiler: e.attribs.class === "spoiler",
      };
    });

  const similar = $(`#similar_movies_list li a[href^="torrents.php?id="]`)
    .toArray()
    .map((e) => parseInt(e.attribs.href.split("id=")[1]));

  const rating = {
    value: parseInt(
      ($(`#user_rating`)[0].firstChild as any).data.split("%")[0]
    ),
    votes: parseInt(
      ($(`#user_total`)[0].firstChild as any).data.split(" votes")[0]
    ),
  };

  return {
    tags,
    collections,
    similar,
    rating,
  };
}

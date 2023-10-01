import * as search from "@googleapis/customsearch";
import Bottleneck from "bottleneck";
import debugPkg from "debug";
import { Album, albumTitle, library } from "../index.js";

const debug = debugPkg.debug("music-scraper:rym-google");

const googleSearchLimiter = new Bottleneck({
  maxConcurrent: 20,
  // 100 queries per minute
  minTime: 1000 * (60 / 100),
  timeout: 5000,
});

const auth = process.env.GOOGLE_SEARCH_API_KEY
  ? search.auth.fromAPIKey(process.env.GOOGLE_SEARCH_API_KEY)
  : undefined;
const client = auth
  ? search.customsearch({ version: "v1", auth }).cse.siterestrict
  : undefined;

export interface GoogleResult {
  link: string;
  cacheUrl?: string;
  rating: {
    count?: number;
    average?: number;
  };
  rawResponse: any; //Schema$Result
}

export interface RymGoogle extends GoogleResult {
  genres: string[];
}

export async function googleSearch(q: string, cx: string) {
  if (!client) {
    return;
  }
  return await googleSearchLimiter.schedule(async () => {
    debug(`fetching Google with query:${q}`);
    const results = await client.list({
      cx,
      q,
      num: 1,
    });

    return results.data.items?.[0];
  });
}

export async function rymGoogleRelease() {
  if (process.env.RYM_GOOGLE_SEARCH_ID)
    await googleRelease(
      "rymGoogle",
      process.env.RYM_GOOGLE_SEARCH_ID,
      (result, raw) => {
        const description: string | undefined =
          raw.pagemap.metatags?.[0]?.["og:description"];

        return {
          ...result,
          genres:
            description?.match(/Genres: ([^\.]+)\./)?.[1]?.split(", ") ?? [],
        };
      }
    );
}
export async function metacriticGoogleRelease() {
  if (process.env.METACRITIC_GOOGLE_SEARCH_ID)
    await googleRelease(
      "metacriticGoogle",
      process.env.METACRITIC_GOOGLE_SEARCH_ID,
      (result) => result
    );
}

type Keys = keyof Pick<Album, "rymGoogle" | "metacriticGoogle">;

export async function googleRelease<T extends Keys>(
  prop: T,
  searchId: string,
  addProps: (result: GoogleResult, raw: any) => Album[T]
) {
  try {
    // GET RYM THINGS!
    if (process.env.GOOGLE_SEARCH_API_KEY && searchId) {
      let counter = 0;

      const albumsToFind = Object.values(library.albums)
        // Filter albums which have no RYM metadata
        .filter(
          (album) =>
            album[prop] === undefined ||
            (process.env.RETRY_FAILED?.includes("google") &&
              album[prop] === null)
        );

      await Promise.all(
        albumsToFind.map(async (album) => {
          try {
            const match = await googleSearch(
              `${album.spotify.artists.map((a) => a.name).join(" ")} ${
                album.spotify.name
              }`,
              searchId
            );

            if (match && match.pagemap && match.link) {
              const ratingCount: string | undefined =
                match.pagemap.aggregaterating?.[0].ratingcount ??
                match.pagemap.aggregaterating?.[0].reviewcount;
              const ratingValue: string | undefined =
                match.pagemap.aggregaterating?.[0].ratingvalue;

              album[prop] = addProps(
                {
                  link: match.link,
                  cacheUrl: match.cacheId
                    ? `https://webcache.googleusercontent.com/search?q=cache:${match.cacheId}:${match.link}&strip=1`
                    : undefined,
                  rating: {
                    count: ratingCount ? parseInt(ratingCount, 10) : undefined,
                    average: ratingValue ? parseFloat(ratingValue) : undefined,
                  },
                  rawResponse: match,
                },
                match
              );
            } else {
              debug(`FAILED - no match found for ${prop} ${albumTitle(album)}`);
              album[prop] = null;
            }
          } catch (error) {
            debug(`FAILED to fetched ${prop} ${albumTitle(album)}`);
            album[prop] = null;

            // Stop if error is thrown
            throw error;
          }
          counter++;
          debug(`DONE ${(counter * 100) / albumsToFind.length}%`);
        })
      );
    } else {
      debug(`WARNING, GOOGLE_SEARCH_API_KEY has not been set`);
    }
  } catch (e) {
    debug(e);
    debug(`FAILED to complete ${prop} google scraping`);
  } finally {
    // Calculate how many albums have RYM metadata
    const found = Object.values(library.albums).filter((a) => a[prop]).length;

    debug(
      `library has ${prop} metadata for ${found}/${
        Object.entries(library.albums).length
      } (${(found * 100) / Object.entries(library.albums).length}%) found`
    );
  }
}

import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { DataQualityEnum, Discojs } from "discojs";
import { albumTitle, library, save } from "..";

const debug = debugInit("music-scraper:discogs");

export type DiscogsMaster = {
  resource_url: string;
} & {
  id: number;
  main_release: number;
  main_release_url: string;
  versions_url: string;
  title: string;
  artists: ({
    resource_url: string;
  } & {
    id: number;
    name: string;
    anv: string;
    join: string;
    role: string;
    tracks: string;
  })[];
  genres: string[];
  styles: string[];
  year: number;
  tracklist: {
    type_: string;
    title: string;
    position: string;
    duration: string;
  }[];
  lowest_price: number;
  num_for_sale: number;
  data_quality: DataQualityEnum;
  images: ({
    resource_url: string;
  } & {
    type: "primary" | "secondary";
    width: number;
    height: number;
    uri: string;
    uri150: string;
  })[];
  videos: {
    title: string;
    description: string;
    duration: number;
    embed: boolean;
    uri: string;
  }[];
  uri: string;
};

export async function discogs() {
  // GET MB THINGS!
  if (process.env.DISCOGS_TOKEN) {
    const client = new Discojs({
      userToken: process.env.DISCOGS_TOKEN,
    });
    debug(`connected to Discogs!`);

    const discogLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1050,
    });

    await Promise.all(
      Object.values(library.albums)
        // Filter albums which have no Discogs metadata
        .filter((album) => album.discogs === undefined)
        .map((album) =>
          discogLimiter.schedule(async () => {
            try {
              let id = album.id?.discogs
                ? parseInt(album.id?.discogs)
                : undefined;

              // Fetch with UPC
              if (!id && album.id?.upc) {
                debug(`fetching Discogs with UPC:${album.id?.upc}`);
                const releases = await client.searchRelease("", {
                  barcode: album.id?.upc,
                });

                id = releases.results[0]?.master_id ?? undefined;
              }

              // Fetch with artist name and release name
              if (!id) {
                debug(`NO master ID found - searching with title/artist`);
                const results = await client.searchMaster("", {
                  artist: album.spotify.artists[0].name,
                  releaseTitle: album.spotify.name,
                });

                id = results.results[0]?.master_id ?? undefined;
                if (id) {
                  debug(
                    `Found master through search: "${results.results[0].title}"`
                  );
                }
              }

              // If we found a master ID -> fetch it!
              if (id) {
                album.id.discogs = id.toString();
                debug(`found master ID ${id} now fetching`);
                const master = await client.getMaster(id);

                album.discogs = { master };
                debug(`SUCCESSFULLY fetched Discogs ${id}`);
              } else {
                debug(`FAILED to fetched Discogs ${albumTitle(album)}`);
                album.discogs = null;
              }
            } catch (error) {
              debug(`FAILED to fetched Discogs ${albumTitle(album)}`);
              debug(error);
              album.discogs = null;
            }
          })
        )
    );
    await save();
  } else {
    debug(`WARNING, DISCOGS_TOKEN has not been set`);
  }

  // Calculate how many albums have Discogs metadata
  const discoFound = Object.values(library.albums).filter((a) => a.discogs)
    .length;

  debug(
    `library has Discogs metadata for ${discoFound}/${
      Object.entries(library.albums).length
    } (${(discoFound * 100) / Object.entries(library.albums).length}%) found`
  );
}

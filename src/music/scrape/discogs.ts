import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { CommunityStatusesEnum, DataQualityEnum, Discojs } from "discojs";
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

export type DiscogsRelease = {
  resource_url: string;
} & {
  id: number;
  title: string;
  format: string;
  major_formats: string[];
  label: string;
  catno: string;
  released: string;
  country: string;
  status: CommunityStatusesEnum.ACCEPTED;
  stats: {
    user: {
      in_collection: number;
      in_wantlist: number;
    };
    community: {
      in_collection: number;
      in_wantlist: number;
    };
  };
  thumb: string;
};

export type DiscogsReleaseRating = {
  release_id: number;
  rating: {
    count: number;
    average: number;
  };
};

export type DiscogsReleaseWithRating = DiscogsRelease & {
  ratings: DiscogsReleaseRating;
};

export async function discogs() {
  // GET MB THINGS!
  if (process.env.DISCOGS_TOKEN) {
    const client = new Discojs({
      userToken: process.env.DISCOGS_TOKEN,
    });

    debug(`connected to Discogs!`);

    const discogLimiter = new Bottleneck({
      maxConcurrent: 2,
      minTime: 1050,
    });

    debug(`fetching masters`);

    let counter = 0;

    const albumsToFind = Object.values(library.albums)
      // Filter albums which have no Discogs metadata
      .filter(
        (album) =>
          album.discogs === undefined ||
          (album.discogs !== null && album.discogs.releases === undefined) ||
          (process.env.RETRY_FAILED === "true" && album.discogs === null)
      );

    await Promise.all(
      albumsToFind.map(async (album) => {
        try {
          let id = album.id?.discogs ? parseInt(album.id?.discogs) : undefined;

          // If master data doesn't exist -> find it
          if (album.discogs?.master === undefined) {
            // Fetch with UPC
            if (!id && album.id?.upc) {
              const releases = await discogLimiter.schedule(() => {
                debug(`fetching Discogs with UPC:${album.id?.upc}`);
                return client.searchRelease("", {
                  barcode: album.id?.upc,
                });
              });

              id = releases.results[0]?.master_id ?? undefined;
            }

            // Fetch with artist name and release name
            if (!id) {
              const results = await discogLimiter.schedule(() => {
                debug(`NO master ID found - searching with title/artist`);
                return client.searchMaster("", {
                  artist: album.spotify.artists[0].name,
                  releaseTitle: album.spotify.name,
                });
              });

              id = results.results[0]?.master_id ?? undefined;
              if (id) {
                debug(
                  `Found master through search: "${results.results[0].title}"`
                );
              }
            }
          }

          // If we found a master ID -> fetch the data!
          if (id) {
            album.id.discogs = id.toString();

            const master =
              album.discogs?.master ??
              (await discogLimiter.schedule(() => {
                debug(`found master ID ${id} now fetching master`);
                return client.getMaster(id!);
              }));

            const releases = (
              await discogLimiter.schedule(() => {
                debug(`fetching releases for ${id}`);
                return client.getMasterVersions(id!);
              })
            ).versions;

            // Only fetch top 10 releases by in_collection
            const top10releases = releases
              .sort(
                (a, b) =>
                  b.stats.community.in_collection -
                  a.stats.community.in_collection
              )
              .slice(0, 10);

            const releasesWithRatings: DiscogsReleaseWithRating[] = await Promise.all(
              top10releases.map(async (release) => {
                const ratings = await discogLimiter.schedule(() => {
                  debug(`fetching ratings for release  ${release.id}`);
                  return client.getCommunityReleaseRating(release.id);
                });
                return { ...release, ratings };
              })
            );

            album.discogs = { master, releases, releasesWithRatings };
            // album.discogs = { master, releases: releasesWithRatings };
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
        counter++;
        if (counter % 100 === 0) {
          await save();
        }
        debug(`DONE ${(counter * 100) / albumsToFind.length}%`);
      })
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

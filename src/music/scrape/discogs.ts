import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { CommunityStatusesEnum, DataQualityEnum, Discojs } from "discojs";
import { albumTitle, library } from "..";
import { googleSearch } from "./google-custom-search";

const debug = debugInit("music-scraper:discogs");

export type DiscogsRelease = {
  resource_url: string;
} & {
  extraartists?:
    | ({
        resource_url: string;
      } & {
        id: number;
        name: string;
        anv: string;
        join: string;
        role: string;
        tracks: string;
      })[]
    | undefined;
  genres?: string[] | undefined;
  styles?: string[] | undefined;
  country?: string | undefined;
  notes?: string | undefined;
  released?: string | undefined;
  released_formatted?: string | undefined;
  tracklist?:
    | {
        type_: string;
        title: string;
        position: string;
        duration: string;
      }[]
    | undefined;
  master_id?: number | undefined;
  master_url?: string | undefined;
  estimated_weight?: number | undefined;
  images?:
    | ({
        resource_url: string;
      } & {
        type: "primary" | "secondary";
        width: number;
        height: number;
        uri: string;
        uri150: string;
      })[]
    | undefined;
  videos?:
    | {
        title: string;
        description: string;
        duration: number;
        embed: boolean;
        uri: string;
      }[]
    | undefined;
} & {
  id: number;
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
  formats: {
    name: string;
    qty: string;
  }[];
  year: number;
  format_quantity: number;
  identifiers: {
    type: string;
    value: string;
  }[];
  labels: ({
    resource_url: string;
  } & {
    id: number;
    name: string;
    entity_type: string;
    entity_type_name: string;
    catno: string;
  })[];
  companies: ({
    resource_url: string;
  } & {
    id: number;
    name: string;
    entity_type: string;
    entity_type_name: string;
    catno: string;
  })[];
  series: ({
    resource_url: string;
  } & {
    id: number;
    name: string;
    entity_type: string;
    entity_type_name: string;
    catno: string;
  })[];
  thumb: string;
  lowest_price: number | null;
  num_for_sale: number;
  date_added: string;
  date_changed: string;
  data_quality: DataQualityEnum;
  status: CommunityStatusesEnum.ACCEPTED;
  community: {
    have: number;
    want: number;
    rating: {
      count: number;
      average: number;
    };
    submitter: {
      resource_url: string;
    } & {
      username: string;
    };
    contributors: ({
      resource_url: string;
    } & {
      username: string;
    })[];
    data_quality: DataQualityEnum;
    status: CommunityStatusesEnum.ACCEPTED;
  };
  uri: string;
};

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

export type DiscogsMasterRelease = {
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

export type DiscogsMasterReleaseRating = {
  release_id: number;
  rating: {
    count: number;
    average: number;
  };
};

export type DiscogsMasterReleaseWithRating = DiscogsMasterRelease & {
  ratings: DiscogsMasterReleaseRating;
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
          (album.discogs !== null &&
            "master" in album.discogs &&
            !album.discogs.releasesWithRatings) ||
          (process.env.RETRY_FAILED === "true" && album.discogs === null)
      );

    await Promise.all(
      albumsToFind.map(async (album) => {
        try {
          let masterId = album.id?.discogs
            ? parseInt(album.id?.discogs, 10)
            : undefined;

          // Fetch with UPC
          if (!masterId && album.id?.upc) {
            const releases = await discogLimiter.schedule(() => {
              debug(`fetching Discogs with UPC:${album.id?.upc}`);
              return client.searchRelease("", {
                barcode: album.id?.upc,
              });
            });

            masterId = releases.results[0]?.master_id ?? undefined;
          }

          // Fetch MASTER with artist name and release name
          if (!masterId && process.env.DISCOGS_GOOGLE_SEARCH_ID) {
            const q = `${album.spotify.artists.map((a) => a.name).join(" ")} ${
              album.spotify.name
            }`;
            const match = await googleSearch(
              q,
              process.env.DISCOGS_GOOGLE_SEARCH_ID
            );
            const idMatch = match?.link?.match(/master\/(.+)/)?.[1];
            masterId = idMatch ? parseInt(idMatch, 10) : undefined;

            if (masterId) {
              debug(`Found master through google search: "${q}"`);
            }
          }

          if (!masterId) {
            const results = await discogLimiter.schedule(() => {
              debug(`NO master ID found - searching with title/artist`);
              return client.searchMaster("", {
                artist: album.spotify.artists[0].name,
                releaseTitle: album.spotify.name,
              });
            });

            masterId = results.results[0]?.master_id ?? undefined;
            if (masterId) {
              debug(
                `Found master through search: "${results.results[0].title}"`
              );
            }
          }

          // If we found a master ID -> fetch the data!
          if (masterId) {
            album.id.discogs = masterId.toString();

            const master = await discogLimiter.schedule(() => {
              debug(`found master ID ${masterId} now fetching master`);
              return client.getMaster(masterId!);
            });

            const releases = (
              await discogLimiter.schedule(() => {
                debug(`fetching releases for ${masterId}`);
                return client.getMasterVersions(masterId!);
              })
            ).versions;

            album.discogs = { master, releases };
            debug(`SUCCESSFULLY fetched Discogs ${masterId}`);

            // If a master has been found - get release reviews
            if (album.discogs.releases) {
              // Only fetch top 10 releases by in_collection
              const top10releases = album.discogs.releases
                .sort(
                  (a, b) =>
                    b.stats.community.in_collection -
                    a.stats.community.in_collection
                )
                .slice(0, 10);

              const releasesWithRatings: DiscogsMasterReleaseWithRating[] = await Promise.all(
                top10releases.map(async (release) => {
                  const ratings = await discogLimiter.schedule(() => {
                    debug(`fetching ratings for release  ${release.id}`);
                    return client.getCommunityReleaseRating(release.id);
                  });
                  return { ...release, ratings };
                })
              );

              album.discogs.releasesWithRatings = releasesWithRatings;
            }
          } else {
            // Last resort, some albums/eps will only have a Discogs releaes - not a master

            // Fetch RELEASE with artist name and release name
            if (process.env.DISCOGS_RELEASE_GOOGLE_SEARCH_ID) {
              const q = `${album.spotify.artists
                .map((a) => a.name)
                .join(" ")} ${album.spotify.name}`;
              const match = await googleSearch(
                q,
                process.env.DISCOGS_RELEASE_GOOGLE_SEARCH_ID
              );
              const idMatch = match?.link?.match(/release\/(.+)/)?.[1];
              const releaseId = idMatch ? parseInt(idMatch, 10) : undefined;

              if (releaseId) {
                debug(`Found release through google search: "${q}"`);
                const release = await discogLimiter.schedule(() => {
                  debug(`fetching release ${releaseId}`);
                  return client.getRelease(releaseId!);
                });

                album.discogs = {
                  release,
                };
              }
            }
          }

          if (!album.discogs) {
            debug(`FAILED to fetched Discogs ${albumTitle(album)}`);
            album.discogs = null;
          }
        } catch (error) {
          debug(`FAILED to fetched Discogs ${albumTitle(album)}`);
          debug(error);
          album.discogs = null;
        }
        counter++;
        debug(`DONE ${(counter * 100) / albumsToFind.length}%`);
      })
    );
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

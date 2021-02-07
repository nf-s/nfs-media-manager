import Bottleneck from "bottleneck";
import { debug as debugInit } from "debug";
import { MusicBrainzApi } from "musicbrainz-api";
import { albumTitle, library, save } from "..";

const debug = debugInit("music-scraper:music-brainz");

export async function musicBrainz() {
  // GET MB THINGS!
  if (
    process.env.MB_APP_NAME &&
    process.env.MB_APP_VERSION &&
    process.env.MB_CONTACT
  ) {
    const mbApi = new MusicBrainzApi({
      appName: process.env.MB_APP_NAME,
      appVersion: process.env.MB_APP_VERSION,
      appContactInfo: process.env.MB_CONTACT,
    });
    debug(`connected to MusicBrainz!`);

    const mbLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 500,
    });

    await Promise.all(
      Object.values(library.albums)
        // Filter albums which have no MusicBrainz metadata
        .filter((album) => album.mb === undefined)
        .map((album) =>
          mbLimiter.schedule(async () => {
            try {
              let id = album.id?.musicBrainz;

              // Fetch with UPC
              if (!id && album.id?.upc) {
                debug(`fetching MusicBrainz with UPC:${album.id?.upc}`);
                const releases = await mbApi.searchRelease(album.id?.upc);

                id = releases.releases[0]?.["release-group"]?.id;
              }

              // Fetch with artist name and release name
              if (!id) {
                debug(
                  `NO release group ID found - searching with title/artist`
                );
                const results = await mbApi.searchReleaseGroup({
                  artist: album.spotify.artists[0].name,
                  releasegroup: album.spotify.name,
                });
                id = results["release-groups"][0]?.id;
                if (id) {
                  debug(
                    `Found release group through search: "${results["release-groups"][0]["artist-credit"]}" - "${results["release-groups"][0].title}"`
                  );
                }
              }

              // If we found a releaseGroup ID -> fetch it!
              if (id) {
                album.id.musicBrainz = id;
                debug(`found release group ID ${id} now fetching`);
                const releaseGroup = await mbApi.getReleaseGroup(id, [
                  "tags",
                  "genres",
                  "url-rels",
                ] as any);
                // const genres = (releaseGroup as any).genres?.map((g: any) => ({
                //   name: g.name,
                //   votes: g.count,
                // }));
                if (!album.id.discogs)
                  album.id.discogs = (releaseGroup as any).relations
                    ?.find((rel: any) => rel.type === "discogs")
                    ?.url?.resource?.split("master/")?.[1];

                if (!album.id.rymUrl)
                  album.id.rymUrl = (releaseGroup as any).relations?.find(
                    (rel: any) =>
                      rel.type === "other databases" &&
                      rel.url?.resource?.includes("rateyourmusic")
                  )?.url?.resource;

                album.mb = { releaseGroup: releaseGroup };
                debug(`SUCCESSFULLY fetched MusicBrainz ${album.id?.upc}`);
              } else {
                debug(`FAILED to fetched MusicBrainz ${albumTitle(album)}`);
                album.mb = null;
              }
            } catch (error) {
              debug(`FAILED to fetched MusicBrainz ${albumTitle(album)}`);
              debug(error);
              album.mb = null;
            }
          })
        )
    );
    await save();
  } else {
    debug(
      `WARNING, no MB_APP_NAME + MB_APP_VERSION + MB_CONTACT have been set`
    );
  }

  // Calculate how many albums have MB metadata
  const mbFound = Object.values(library.albums).filter((a) => a.mb).length;

  debug(
    `library has MusicBrainz metadata for ${mbFound}/${
      Object.entries(library.albums).length
    } (${(mbFound * 100) / Object.entries(library.albums).length}%) found`
  );
}

import debugPkg from "debug";
import { albumTitle, library } from "./index.js";
import { AlbumId } from "./clean/interfaces.js";

const debug = debugPkg.debug("music-scraper:remove-dupes");

/** Keep A Album if addedDate is before B */
function keepA(a: string, b: string) {
  return (
    new Date(library.albums[a].spotify.addedDate) <
    new Date(library.albums[b].spotify.addedDate)
  );
}

export async function removeDupes(testMode = false) {
  debug(`Search for duplicates ${testMode ? "IN TEST MODE" : ""}`);

  /** Map from Album "sub" id to actual album ID */
  const albumIdMaps: Record<keyof AlbumId, Map<string, string>> = {
    spotify: new Map(),
    upc: new Map(),
    musicBrainz: new Map(),
    discogs: new Map(),
    lastFmUrl: new Map(),
  };

  /** Map from album title to album (spotify) ID */
  const albumTitles = new Map<string, string>();

  const dupes = new Set<string>();

  Object.entries(library.albums).forEach(([albumId, album]) => {
    const title = albumTitle(album);

    // Search for duplicate albums (for each album sub ID)
    Object.keys(album.id).forEach((albumIdKey) => {
      if (
        albumIdKey !== "spotify" &&
        albumIdKey !== "upc" &&
        albumIdKey !== "musicBrainz" &&
        albumIdKey !== "discogs"
      )
        return;
      const albumSubId = album.id[albumIdKey];
      const albumSubIdMap = albumIdMaps[albumIdKey as keyof AlbumId];
      if (albumSubId) {
        const existingSubId = albumSubIdMap.get(albumSubId);
        if (existingSubId) {
          debug(`found dupe ${title} (using ${albumIdKey})`);

          // Do we keep current album instead of existing?
          if (keepA(albumId, existingSubId)) {
            dupes.add(existingSubId);
            // Set albumSubIdMap map to current albumId
            albumSubIdMap.set(albumSubId, albumId);
            debug(`keeping ${albumId} over ${existingSubId}`);
          } else {
            debug(`keeping ${existingSubId} over ${albumId}`);
            dupes.add(albumId);
          }
        } else {
          albumSubIdMap.set(albumId, albumSubId);
        }
      }
    });

    // Search for duplicate albums by album title (and artist)
    const existingId = albumTitles.get(title);
    if (existingId) {
      debug(`found dupe ${title} (using title)`);

      // Do we keep current album instead of existing?
      if (keepA(albumId, existingId)) {
        dupes.add(existingId);
        // Set albumTitles map to current albumId
        albumTitles.set(title, albumId);
        debug(`keeping ${albumId} over ${existingId}`);
      } else {
        debug(`keeping ${existingId} over ${albumId}`);
        dupes.add(albumId);
      }
    } else {
      albumTitles.set(title, albumId);
    }
  });

  if (testMode) {
    debug(dupes);
  } else {
    dupes.forEach((dupe) => {
      debug(`DELETING!! ${dupe}`);
      delete library.albums[dupe];
      if (!library.blacklistedAlbums) {
        library.blacklistedAlbums = [];
      }
      library.blacklistedAlbums.push(dupe);
    });
  }
}

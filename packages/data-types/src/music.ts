import { Links } from "./common.js";
import { FilterValue, SortValue } from "./fields.js";

export interface AudioFeatures {
  acousticness?: number;
  danceability?: number;
  energy?: number;
  instrumentalness?: number;
  liveness?: number;
  loudness?: number;
  mode?: number;
  speechiness?: number;
  tempo?: number;
  valence?: number;
}

export type AlbumId = {
  spotify: string;
  upc?: string;
  // rymUrl?: string;
  musicBrainz?: string;
  discogs?: string;
  lastFmUrl?: string;
};

export interface CleanAlbumBase {
  spotifyId: string;
  title: string;
  artists: string[];
  dateReleased: number;

  art: string | undefined;
}
export interface CleanAlbum extends AudioFeatures, CleanAlbumBase {
  id: AlbumId;
  durationSec: number;
  dateAdded: number;
  genres: string[];
  playlists: string[];
  /** Array of track IDS (eg `"4iV5W9uYEdYUVa79Axb7Rh"`) - NOT Spotify URIs (eg `"spotify:track:4iV5W9uYEdYUVa79Axb7Rh"`) */
  tracks: string[];
  countries: string[];

  ratingRymVotes?: number;
  ratingRymValue?: number;
  ratingDiscogsVotes?: number;
  ratingDiscogsValue?: number;
  ratingMetacriticVotes?: number;
  ratingMetacriticValue?: number;
  popularityDiscogs?: number;
  popularitySpotify?: number;
  popularityLastFm?: number;
  scrobbles?: number;
  links: Links<"spotify" | "rym" | "discogs" | "lastfm" | "mb" | "mc">;
}

export interface CleanAlbumPlaylist {
  name: string;
  id: string;
  albums: (CleanAlbumBase | string)[];
}

export interface CleanLibrary {
  albums: { [id: string]: CleanAlbum };
  playlists: { [id: string]: CleanAlbumPlaylist };
}

export interface CleanTrack extends AudioFeatures {
  spotifyId: string;
  title: string;
  artists: string[];
  release: string;
  durationSec: number;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  key?: number;
}

export interface CleanTrackPlaylist {
  name: string;
  tracks: CleanTrack[];
}

export interface SyncPlaylist<T> {
  name: string;
  filters?: FilterValue<T>[];
  sort?: SortValue<T>;
  forceRecreate?: boolean;
  limit?: number;
  /** Defaults to true. If true, then playlist will only be synced if number of tracks has changed. If false, then full sync will occur. */
  lazyUpdate?: boolean;
}

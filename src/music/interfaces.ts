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
};

export interface CleanAlbum extends AudioFeatures {
  id: AlbumId;
  spotifyId: string;
  title: string;
  artist: string;
  durationSec: number;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  tracks: string[];
  art: string | undefined;

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
  links: {
    spotify: string;
    rym?: string;
    discogs?: string;
    lastfm?: string;
    mb?: string;
    mc?: string;
  };
  otherTitles: {
    rym?: string;
    discogs?: string;
    lastfm?: string;
    mb?: string;
    csv?: string;
    mc?: string;
  };
}

export type CleanLibrary = CleanAlbum[];

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

export type CleanPlaylist = CleanTrack[];

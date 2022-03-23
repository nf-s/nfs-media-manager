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

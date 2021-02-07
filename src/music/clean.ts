import { library } from ".";

export interface CleanAlbum {
  id: string;
  title: string;
  artist: string;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  tracks: string[];
}

export type CleanLibrary = CleanAlbum[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.albums).map((album) => {
    const clean: CleanAlbum = {
      id: album.spotify.id,
      title: album.spotify.name,
      artist: album.spotify.artists.map((artist) => artist.name).join(", "),
      dateReleased: album.spotify.release_date,
      dateAdded: album.spotify.addedDate,
      genres: album.spotify.genres,
      tracks: album.spotify.tracks.items.map((track) => track.id),
    };

    return clean;
  });
}

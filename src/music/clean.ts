import { library } from ".";

export interface CleanAlbum {
  id: string;
  title: string;
  artist: string;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
}

export type CleanLibrary = CleanAlbum[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.albums).map((album) => {
    const clean: CleanAlbum = {
      id: album.id,
      title: album.name,
      artist: album.artists.map((artist) => artist.name).join(", "),
      dateReleased: album.release_date,
      dateAdded: album.addedDate,
      genres: album.genres,
    };

    return clean;
  });
}

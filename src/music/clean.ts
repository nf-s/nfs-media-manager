import { AlbumId, library } from ".";

export interface CleanAlbum {
  id: AlbumId;
  title: string;
  artist: string;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  tracks: string[];
  art: string | undefined;
}

export type CleanLibrary = CleanAlbum[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.albums).map((album) => {
    const mbGenres = (album.mb?.releaseGroup as any)?.genres?.map(
      (g: any) => g.name
    );
    const genres = [
      ...(album.discogs?.master.genres ?? []),
      ...(album.discogs?.master.styles ?? []),
      ...(!album.id.discogs ? mbGenres ?? [] : []),
    ].map((g) => (g as string).toLowerCase());

    const clean: CleanAlbum = {
      id: album.id,
      title: album.spotify.name,
      artist: album.spotify.artists.map((artist) => artist.name).join(", "),
      dateReleased: album.spotify.release_date,
      dateAdded: album.spotify.addedDate,
      genres,
      tracks: album.spotify.tracks.items.map((track) => track.id),
      art: album.spotify.images.find((i) => i.height === 300)?.url,
    };

    return clean;
  });
}

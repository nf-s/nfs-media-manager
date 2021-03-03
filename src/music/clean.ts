import { AlbumId, library } from ".";

export interface CleanAlbum {
  id: AlbumId;
  title: string;
  artist: string;
  durationSec: number;
  dateReleased: string;
  dateAdded: string;
  genres: string[];
  tracks: string[];
  art: string | undefined;
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  mode: number;
  speechiness: number;
  tempo: number;
  valence: number;
  ratingDiscogsVotes?: number;
  ratingDiscogsValue?: number;
  popularityDiscogs?: number;
  popularitySpotify?: number;
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

    const mean = (nums: number[]) =>
      nums.length === 0
        ? 0
        : nums.reduce((sum, num) => sum + num, 0) / nums.length;

    const discogsRating = album.discogs?.releasesWithRatings?.reduce<{
      votes: number;
      value: number;
    }>(
      (rating, release) => {
        rating.value +=
          release.ratings.rating.average * release.ratings.rating.count;
        rating.votes += release.ratings.rating.count;
        return rating;
      },
      { votes: 0, value: 0 }
    );

    if (discogsRating?.value !== undefined && discogsRating?.votes !== 0)
      discogsRating.value = discogsRating.value / discogsRating.votes;

    const discogsPopularity = album.discogs?.releases?.reduce<number>(
      (pop, release) =>
        pop +
        release.stats.community.in_collection +
        release.stats.community.in_wantlist,
      0
    );

    const clean: CleanAlbum = {
      id: album.id,
      title: album.spotify.name,
      artist: album.spotify.artists.map((artist) => artist.name).join(", "),
      durationSec: album.spotify.tracks.items.reduce<number>(
        (sec, track) => sec + track.duration_ms / 1000,
        0
      ),
      dateReleased: album.spotify.release_date,
      dateAdded: album.spotify.addedDate,
      genres,
      tracks: album.spotify.tracks.items.map((track) => track.id),
      art: album.spotify.images.find((i) => i.height === 300)?.url,
      ratingDiscogsValue: discogsRating?.value,
      ratingDiscogsVotes: discogsRating?.votes,
      popularityDiscogs: discogsPopularity,
      popularitySpotify: album.spotify.popularity,
      acousticness: mean(
        album.spotify.audioFeatures.map((a) => a.acousticness)
      ),
      danceability: mean(
        album.spotify.audioFeatures.map((a) => a.danceability)
      ),
      energy: mean(album.spotify.audioFeatures.map((a) => a.energy)),
      instrumentalness: mean(
        album.spotify.audioFeatures.map((a) => a.instrumentalness)
      ),
      liveness: mean(album.spotify.audioFeatures.map((a) => a.liveness)),
      loudness: mean(album.spotify.audioFeatures.map((a) => a.loudness)),
      mode: mean(album.spotify.audioFeatures.map((a) => a.mode)),
      speechiness: mean(album.spotify.audioFeatures.map((a) => a.speechiness)),
      tempo: mean(album.spotify.audioFeatures.map((a) => a.tempo)),
      valence: mean(album.spotify.audioFeatures.map((a) => a.valence)),
    };

    return clean;
  });
}

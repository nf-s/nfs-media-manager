import { CleanPlaylist, CleanTrack } from "./interfaces";
import { SpotifyPlaylistTrack } from "./scrape/spotify";

export async function clean(
  playlist: SpotifyPlaylistTrack[]
): Promise<CleanPlaylist> {
  return playlist
    .map((track) => {
      try {
        const genres = new Set<string>();
        track.artists?.forEach((a) =>
          a.genres.forEach((genre) => genres.add(genre))
        );

        const cleanTrack: CleanTrack = {
          spotifyId: track.track.id,
          title: track.track.name,
          artists: track.artists?.map((artist) => artist.name) ?? [],
          release: "album" in track.track ? track.track.album.name : "",
          durationSec: track.track.duration_ms / 1000,
          dateReleased:
            "album" in track.track ? track.track.album.release_date : "",
          dateAdded: track.added_at,
          genres: Array.from(genres),

          acousticness: track.audioFeatures?.acousticness,
          danceability: track.audioFeatures?.danceability,
          energy: track.audioFeatures?.energy,
          instrumentalness: track.audioFeatures?.instrumentalness,
          liveness: track.audioFeatures?.liveness,
          loudness: track.audioFeatures?.loudness,
          mode: track.audioFeatures?.mode,
          speechiness: track.audioFeatures?.speechiness,
          tempo: track.audioFeatures?.tempo,
          valence: track.audioFeatures?.valence,
        };

        return cleanTrack;
      } catch (error) {
        console.error(
          `FAILED to clean track ${track.track.name} - ${track.artists
            ?.map((a) => a.name)
            .join(",")}`
        );
        console.error(error);
      }
    })
    .filter((track) => typeof track !== "undefined") as CleanPlaylist;
}

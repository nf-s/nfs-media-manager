import SpotifyWebApi from "spotify-web-api-js";

export const PLAYLIST_NAME = "_nick-web-player-queue";

export async function getQueuePlaylistId(
  spotifyApi: SpotifyWebApi.default.SpotifyWebApiJs,
  userId: string
) {
  let playlistId = await new Promise<string | undefined>((resolve, reject) => {
    const getAlbums = async (offset = 0, limit = 50) => {
      console.log(`fetching spotify playlists offset=${offset}`);
      try {
        const response = await spotifyApi.getUserPlaylists(userId, {
          limit,
          offset,
        });
        const queuePlaylist = response.items.find(
          (playlist) => playlist.name === PLAYLIST_NAME
        );
        if (queuePlaylist) {
          resolve(queuePlaylist.id);
          console.log(`FOUND PLAYLIST! ${queuePlaylist.id}`);
          return;
        }
        const nextOffset = response.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getAlbums(parseInt(nextOffset));
        } else {
          console.log(`FINISHED fetching spotify playlists`);
          resolve(undefined);
        }
      } catch (error) {
        console.log(`FAILED to fetched spotify playlists offset=${offset}`);
        console.log(error);
        reject();
      }
    };

    getAlbums();
  });

  if (playlistId === undefined) {
    const playlist = await spotifyApi.createPlaylist(userId, {
      name: PLAYLIST_NAME,
      public: false,
      description:
        "This playlist was created by Nick's Spotify Web Player because Spotify Web API is garbage.",
    });

    playlistId = playlist.id;
  }

  return playlistId;
}

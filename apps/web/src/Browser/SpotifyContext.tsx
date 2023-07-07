import { CleanAlbum, CleanTrack } from "data-types";
import React, { createContext, useEffect, useReducer } from "react";
import SpotifyWebApi from "spotify-web-api-js";
import { SpotifyAuth } from "./SpotifyAuth.js";

interface SpotifyState {
  authToken?: string;
  api?: SpotifyWebApi.default.SpotifyWebApiJs;
  userId?: string | undefined;
  queuePlaylist?: string | undefined;
  deviceId?: string | undefined;
  uris?: string | string[];
  play?: boolean;
  waitForPlay?: boolean;
}

export const SpotifyContext = createContext<SpotifyState | undefined>(
  undefined
);
export const SpotifyDispatchContext = createContext<
  React.Dispatch<SpotifyDispatchActions> | undefined
>(undefined);

export const SpotifyProvider: React.FC<{
  authRequired: boolean;
  children: React.ReactNode;
}> = ({ authRequired, children }) => {
  const [state, dispatch] = useReducer(spotifyReducer, undefined);

  // Init spotify auth (which sets authToken)
  useEffect(() => {
    if (!state?.authToken && authRequired) {
      const spotifyAuth = new SpotifyAuth((token) => {
        dispatch({ type: "update", value: { authToken: token } });
      });
      spotifyAuth.init();
    }
  }, [dispatch, state?.authToken, authRequired]);

  // Set spotify api object after auth token is set
  useEffect(() => {
    if (dispatch && state?.authToken && !state?.api) {
      const spotifyApi = new (SpotifyWebApi as any)();
      spotifyApi.setAccessToken(state.authToken);
      dispatch({ type: "update", value: { api: spotifyApi } });
    }
  }, [dispatch, state?.authToken, state?.api]);

  // Set spotify user and queue playlist ID after spotify api object is set
  useEffect(() => {
    const fetchSpotifyUser = async () => {
      if (!state || !state?.api || state.userId) return;

      const user = await state.api.getMe();

      let playlistId = localStorage.getItem("spotifyPlaylistId");

      if (user && !playlistId) {
        playlistId = await getQueuePlaylistId(state.api, user.id);
        if (playlistId)
          localStorage.setItem("spotifyPlaylistId", playlistId ?? "");
      }

      dispatch({
        type: "update",
        value: {
          userId: user?.id,
          queuePlaylist: playlistId ?? undefined,
          uris: [`spotify:playlist:${playlistId}`],
        },
      });
    };

    fetchSpotifyUser();
  }, [state]);

  return (
    <SpotifyContext.Provider value={state}>
      <SpotifyDispatchContext.Provider value={dispatch}>
        {children}
      </SpotifyDispatchContext.Provider>
    </SpotifyContext.Provider>
  );
};

type SpotifyDispatchActions =
  | {
      type: "update";
      value: SpotifyState;
    }
  | {
      type: "playAlbum";
      row: CleanAlbum;
    }
  | {
      type: "playTrack";
      row: CleanTrack;
    };

function spotifyReducer(
  spotifyState: SpotifyState | undefined,
  action: SpotifyDispatchActions
): SpotifyState | undefined {
  switch (action.type) {
    case "update": {
      return { ...spotifyState, ...action.value };
    }
    case "playAlbum": {
      return {
        ...spotifyState,
        uris: [`spotify:album:${action.row.id.spotify}`],
        play: true,
      };
    }
    case "playTrack": {
      return {
        ...spotifyState,
        uris: [`spotify:track:${action.row.spotifyId}`],
        play: true,
      };
    }
    default: {
      throw Error("Unknown action: " + JSON.stringify(action));
    }
  }
}

export function queueAlbum(
  spotifyState: SpotifyState | undefined,
  row: CleanAlbum
) {
  spotifyState?.queuePlaylist && spotifyState.api
    ? spotifyState.api.addTracksToPlaylist(
        spotifyState?.queuePlaylist,
        row.tracks.map((id) => `spotify:track:${id}`)
      )
    : alert("Queue playlist ID not set!");
}

export function queueTrack(
  spotifyState: SpotifyState | undefined,
  row: CleanTrack
) {
  spotifyState?.queuePlaylist && spotifyState.api
    ? spotifyState.api.addTracksToPlaylist(spotifyState?.queuePlaylist, [
        `spotify:track:${row.spotifyId}`,
      ])
    : alert("Queue playlist ID not set!");
}

const PLAYLIST_NAME = "_nick-web-player-queue";

async function getQueuePlaylistId(
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
          return;
        }
        const nextOffset = response.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getAlbums(parseInt(nextOffset));
        } else {
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

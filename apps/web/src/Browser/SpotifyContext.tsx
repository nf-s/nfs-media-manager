import { CleanAlbum, CleanTrack } from "data-types";
import React, { createContext, useEffect, useReducer } from "react";
import SpotifyWebApi from "spotify-web-api-js";
import { SpotifyAuth, getQueuePlaylistId } from "./Spotify.js";

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
  children: React.ReactNode;
}> = ({ children }) => {
  const [state, dispatch] = useReducer(spotifyReducer, undefined);

  // Init spotify auth (which sets authToken)
  useEffect(() => {
    if (!state?.authToken) {
      const spotifyAuth = new SpotifyAuth((token) => {
        dispatch({ type: "update", value: { authToken: token } });
      });
      spotifyAuth.init();
    }
  }, [dispatch, state?.authToken]);

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
      console.log("play album");
      return {
        ...spotifyState,
        uris: [`spotify:album:${action.row.id.spotify}`],
        play: true,
      };
    }
    case "playTrack": {
      console.log("play track");
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

import { CleanAlbum, CleanLibrary, CleanTrack } from "data-types";
import React, { useCallback, useEffect, useState } from "react";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { useTraceUpdate } from "../Common/util.js";
import * as Album from "../Models/Album.jsx";
import * as Playlist from "../Models/Playlist.jsx";
import Browser from "./Browser.jsx";
import { SpotifyAuth, getQueuePlaylistId } from "./Spotify.js";

function Music(props: { darkMode: boolean; mode: "albums" | "playlist" }) {
  useTraceUpdate(props);

  const [spotifyAuthToken, setSpotifyAuthToken] = useState<string>();

  useEffect(() => {
    if (!spotifyAuthToken) {
      const spotifyAuth = new SpotifyAuth(setSpotifyAuthToken);
      spotifyAuth.init();
    }
  }, [spotifyAuthToken]);

  const [spotify, setSpotifyApi] = useState<{
    api: SpotifyWebApi.default.SpotifyWebApiJs;
  }>();

  const [rowData, setData] = useState<{
    rows: CleanAlbum[];
  }>({ rows: [] });

  // const [playlistData, setPlaylistData] = useState<{
  //   rows: CleanTrack[];
  // }>({ rows: [] });
  const playlistData = { rows: [] };

  const [playerState, setSpotifyPlayerState] = useState<
    | {
        uris?: string | string[];
        play?: boolean;
        waitForPlay?: boolean;
      }
    | undefined
  >(undefined);

  const [spotifyState, setSpotifyState] = useState<
    | {
        userId?: string | undefined;
        queuePlaylist?: string | undefined;
        deviceId?: string | undefined;
      }
    | undefined
  >(undefined);

  const playAlbum = useCallback(
    (row: CleanAlbum) => {
      setSpotifyPlayerState({
        uris: [`spotify:album:${row.id.spotify}`],
        play: true,
      });
    },
    [setSpotifyPlayerState]
  );

  const queueAlbum = useCallback(
    (row: CleanAlbum) => {
      spotifyState?.queuePlaylist && spotify
        ? spotify.api.addTracksToPlaylist(
            spotifyState?.queuePlaylist,
            row.tracks.map((id) => `spotify:track:${id}`)
          )
        : alert("Queue playlist ID not set!");
    },
    [spotifyState, spotify]
  );

  const playTrack = useCallback(
    (row: CleanTrack) => {
      setSpotifyPlayerState({
        uris: [`spotify:track:${row.spotifyId}`],
        play: true,
      });
    },
    [setSpotifyPlayerState]
  );

  const queueTrack = useCallback(
    (row: CleanTrack) => {
      spotifyState?.queuePlaylist && spotify
        ? spotify.api.addTracksToPlaylist(spotifyState?.queuePlaylist, [
            `spotify:track:${row.spotifyId}`,
          ])
        : alert("Queue playlist ID not set!");
    },
    [spotifyState, spotify]
  );

  useEffect(() => {
    if (spotifyAuthToken && !spotify?.api) {
      const spotifyApi = new (SpotifyWebApi as any)();
      spotifyApi.setAccessToken(spotifyAuthToken);

      setSpotifyApi({ api: spotifyApi });
    }
  }, [spotifyAuthToken, spotify]);

  useEffect(() => {
    if (rowData.rows.length > 0) return;

    const fetchData = async () => {
      const library = (await (
        await fetch("/lib-music.json")
      ).json()) as CleanLibrary;

      setData({
        rows: Object.values(library.albums),
      });

      // const playlist = (await axios("/4VZp1yvv27nEcEJXG3dVYb.json"))
      //   .data as CleanTrackPlaylist;

      // setPlaylistData({
      //   rows: playlist.tracks,
      // });
    };

    fetchData();
  }, [rowData]);

  useEffect(() => {
    if (!spotify || spotifyState) return;

    const fetchSpotifyUser = async () => {
      const user = await spotify.api.getMe();

      let playlistId = localStorage.getItem("spotifyPlaylistId");

      if (!playlistId) {
        playlistId = await getQueuePlaylistId(spotify.api, user.id);
        if (playlistId)
          localStorage.setItem("spotifyPlaylistId", playlistId ?? "");
      }

      setSpotifyState({
        userId: user.id,
        queuePlaylist: playlistId,
      });
    };

    fetchSpotifyUser();
  }, [spotifyState, spotify]);

  useEffect(() => {
    if (playerState || !spotifyState?.queuePlaylist) return;

    setSpotifyPlayerState({
      uris: [`spotify:playlist:${spotifyState.queuePlaylist}`],
    });
  }, [spotifyState, playerState]);

  return (
    <div className="root-music">
      {props.mode === "albums" ? (
        <Browser
          tag={"album"}
          rows={rowData.rows}
          columnsConfig={Album.columnsConfig}
        />
      ) : (
        <Browser
          tag={"playlist"}
          rows={playlistData.rows}
          columnsConfig={Playlist.columnsConfig}
        />
      )}

      <div className={"player"}>
        {spotifyAuthToken ? (
          <SpotifyPlayer
            name="Nick's Web Player"
            showSaveIcon={true}
            token={spotifyAuthToken}
            callback={(state: any) => {
              console.log(playerState?.uris);
              console.log(state);

              if (state.deviceId)
                setSpotifyState({ ...spotifyState, deviceId: state.deviceId });
              if (state.isPlaying)
                setSpotifyPlayerState({ ...playerState, waitForPlay: false });
              if (!state.isPlaying && playerState?.waitForPlay) return;

              if (!spotifyState?.queuePlaylist || state.type !== "track_update")
                return;

              if (!state.isPlaying && state.nextTracks.length === 0) {
                // Hacky way to get my playlist queue to start if there aren't any tracks to play
                setSpotifyPlayerState({
                  ...playerState,
                  uris: [],
                  play: false,
                  waitForPlay: true,
                });
                setTimeout(() => {
                  setSpotifyPlayerState({
                    ...playerState,
                    uris: [`spotify:playlist:${spotifyState.queuePlaylist}`],
                    play: true,
                    waitForPlay: true,
                  });
                }, 500);
              } else if (
                state.isPlaying &&
                playerState?.uris?.[0] ===
                  `spotify:playlist:${spotifyState.queuePlaylist}` &&
                spotify
              ) {
                spotify.api
                  .getMyCurrentPlaybackState()
                  .then((playbackState) => {
                    if (
                      spotifyState.queuePlaylist &&
                      playbackState.context?.uri ===
                        `spotify:playlist:${spotifyState.queuePlaylist}`
                    ) {
                      console.log(`removing ${state.track.uri} from quu`);
                      spotify.api.removeTracksFromPlaylist(
                        spotifyState.queuePlaylist,
                        [state.track.uri]
                      );
                    }
                  });
              }
            }}
            play={playerState?.play}
            uris={playerState?.uris}
            styles={{
              activeColor: "#00c583",
              bgColor: "#333",
              color: "#fff",
              loaderColor: "#fff",
              sliderColor: "#00c583",
              sliderHandleColor: "#dbfff8",
              trackArtistColor: "#ccc",
              trackNameColor: "#fff",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default Music;

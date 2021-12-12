import axios from "axios";
import React, { useCallback, useEffect, useState } from "react";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import {
  CleanTrack,
  CleanAlbum,
} from "../../movie-scraper/src/music/interfaces";
import Browser from "./Browser";
import config from "./config.json";
import { getQueuePlaylistId } from "./Spotify";
import {
  defaultFilter,
  defaultSort,
  defaultVisible,
  gridCols,
  numericCols,
  textColumns,
} from "./Table/Album";

import * as Playlist from "./Table/Playlist";
import { useTraceUpdate } from "./util";

function Music(props: {
  spotifyToken: string;
  darkMode: boolean;
  mode: "albums" | "playlist";
}) {
  useTraceUpdate(props);
  const [spotify, setSpotifyApi] =
    useState<{ api: SpotifyWebApi.SpotifyWebApiJs }>();
  const [rowData, setData] = useState<{
    rows: CleanAlbum[];
  }>({ rows: [] });

  const [playlistData, setPlaylistData] = useState<{
    rows: CleanTrack[];
  }>({ rows: [] });

  const [deviceId, setDeviceId] = useState<{ id?: string }>({});

  const [playerState, setSpotifyPlayer] = useState<{
    uris?: string | string[];
    play?: boolean;
    waitForPlay?: boolean;
  }>({ play: true });

  const [spotifyState, setSpotifyUser] = useState<{
    id: string;
    queuePlaylist: string;
  }>();

  const playAlbum = useCallback(
    (row: CleanAlbum) => {
      setSpotifyPlayer({
        uris: [`spotify:album:${row.id.spotify}`],
        play: true,
      });
    },
    [setSpotifyPlayer]
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
      setSpotifyPlayer({
        uris: [`spotify:track:${row.spotifyId}`],
        play: true,
      });
    },
    [setSpotifyPlayer]
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
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(props.spotifyToken);

    setSpotifyApi({ api: spotifyApi });
  }, [props.spotifyToken]);

  useEffect(() => {
    const fetchData = async () => {
      const result = await axios("/lib-music.json");

      const rows = result.data as CleanAlbum[];

      const ye = new Intl.DateTimeFormat("en", { year: "numeric" });
      const mo = new Intl.DateTimeFormat("en", { month: "2-digit" });
      const da = new Intl.DateTimeFormat("en", { day: "2-digit" });

      setData({
        rows: rows.map((row) => {
          const dateAdded = new Date(row.dateAdded);
          row.dateAdded = `${ye.format(dateAdded)}/${mo.format(
            dateAdded
          )}/${da.format(dateAdded)}`;
          const dateReleased = new Date(row.dateReleased);
          row.dateReleased = `${ye.format(dateReleased)}/${mo.format(
            dateReleased
          )}/${da.format(dateReleased)}`;
          return row;
        }),
      });

      const playlist = await axios("/6H6tTq8Is6D2X8PZi5rJmK.json");

      const tracks = playlist.data as CleanTrack[];

      setPlaylistData({
        rows: tracks,
      });
    };

    fetchData();
  }, []);

  useEffect(() => {
    const fetchSpotifyUser = async () => {
      if (!spotify) return;
      const user = await spotify.api.getMe();

      let playlistId =
        config.spotifyPlaylistId ??
        (await getQueuePlaylistId(spotify.api, user.id));

      setSpotifyUser({ id: user.id, queuePlaylist: playlistId });
      if (playerState.uris && playerState.uris.length === 0) {
        setSpotifyPlayer({ uris: [`spotify:playlist:${playlistId}`] });
      }
    };

    fetchSpotifyUser();
  }, [playerState, spotify]);

  return (
    <div className="root-music">
      {props.mode === "albums" ? (
        <Browser
          idCol={"spotifyId"}
          tag={"album"}
          rows={rowData.rows}
          filterCols={defaultFilter}
          defaultSort={defaultSort}
          defaultVisible={defaultVisible}
          numericCols={numericCols}
          textColumns={textColumns}
          gridColumns={gridCols}
          play={playAlbum}
          queue={queueAlbum}
        />
      ) : (
        <Browser
          idCol={"spotifyId"}
          tag={"playlist"}
          rows={playlistData.rows}
          filterCols={["artists", "genres"]}
          defaultSort={Playlist.defaultSort}
          defaultVisible={Playlist.defaultVisible}
          numericCols={Playlist.numericCols}
          textColumns={Playlist.textColumns}
          gridColumns={{
            width: 250,
            height: 250,
            cols: [
              Playlist.textColumns[0],
              Playlist.textColumns[1],
              Playlist.textColumns[5],
            ],
          }}
          play={playTrack}
          queue={queueTrack}
        />
      )}

      <div className={"player"}>
        <SpotifyPlayer
          name="Nick's Web Player"
          persistDeviceSelection={true}
          showSaveIcon={true}
          token={props.spotifyToken}
          callback={(state) => {
            console.log(playerState.uris);
            console.log(state);

            if (state.deviceId) setDeviceId({ id: state.deviceId });
            if (state.isPlaying) playerState.waitForPlay = false;
            if (!state.isPlaying && playerState.waitForPlay) return;

            if (!spotifyState?.queuePlaylist || state.type !== "track_update")
              return;

            if (!state.isPlaying && state.nextTracks.length === 0) {
              // Hacky way to get my playlist queue to start if there aren't any tracks to play
              setSpotifyPlayer({
                uris: [],
                play: false,
                waitForPlay: true,
              });
              setTimeout(() => {
                setSpotifyPlayer({
                  uris: [`spotify:playlist:${spotifyState.queuePlaylist}`],
                  play: true,
                  waitForPlay: true,
                });
              }, 500);
            } else if (
              state.isPlaying &&
              playerState.uris?.[0] ===
                `spotify:playlist:${spotifyState.queuePlaylist}` &&
              spotify
            ) {
              spotify.api.getMyCurrentPlaybackState().then((playbackState) => {
                if (
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
          play={playerState.play}
          autoPlay={true}
          uris={playerState.uris}
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
      </div>
    </div>
  );
}

export default Music;

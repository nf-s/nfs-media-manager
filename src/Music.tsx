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
  defaultSort,
  defaultVisible,
  numericCols,
  textColumns,
} from "./Table/Album";

import * as Playlist from "./Table/Playlist";

function Music(props: { spotifyToken: string; darkMode: boolean }) {
  const [spotifyApi, setSpotifyApi] = useState<SpotifyWebApi.SpotifyWebApiJs>();
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

  const playAlbum = (row: CleanAlbum) => {
    setSpotifyPlayer({
      uris: [`spotify:album:${row.id.spotify}`],
      play: true,
    });
  };

  const queueAlbum = useCallback(
    (row: CleanAlbum) => {
      spotifyState?.queuePlaylist && spotifyApi
        ? spotifyApi.addTracksToPlaylist(
            spotifyState?.queuePlaylist,
            row.tracks.map((id) => `spotify:track:${id}`)
          )
        : alert("Queue playlist ID not set!");
    },
    [spotifyState, spotifyApi]
  );

  const playTrack = (row: CleanTrack) => {
    setSpotifyPlayer({
      uris: [`spotify:track:${row.spotifyId}`],
      play: true,
    });
  };

  const queueTrack = useCallback(
    (row: CleanTrack) => {
      spotifyState?.queuePlaylist && spotifyApi
        ? spotifyApi.addTracksToPlaylist(spotifyState?.queuePlaylist, [
            `spotify:track:${row.spotifyId}`,
          ])
        : alert("Queue playlist ID not set!");
    },
    [spotifyState, spotifyApi]
  );

  useEffect(() => {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(props.spotifyToken);

    setSpotifyApi(spotifyApi);
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
      if (!spotifyApi) return;
      const user = await spotifyApi.getMe();

      let playlistId =
        config.spotifyPlaylistId ??
        (await getQueuePlaylistId(spotifyApi, user.id));

      setSpotifyUser({ id: user.id, queuePlaylist: playlistId });
      if (playerState.uris && playerState.uris.length === 0) {
        setSpotifyPlayer({ uris: [`spotify:playlist:${playlistId}`] });
      }
    };

    fetchSpotifyUser();
  }, [playerState, spotifyApi]);

  return (
    <div className="root-music">
      {/* <Browser
        rows={rowData.rows}
        filterCols={["title", "artist", "genres"]}
        defaultSort={defaultSort}
        defaultVisible={defaultVisible}
        numericCols={numericCols}
        textColumns={textColumns}
        gridColumns={{
          art: "art",
          cols: [textColumns[0], textColumns[1], textColumns[5]],
        }}
        play={playAlbum}
        queue={queueAlbum}
      /> */}
      <Browser
        rows={playlistData.rows}
        filterCols={["title", "artists", "genres"]}
        defaultSort={Playlist.defaultSort}
        defaultVisible={Playlist.defaultVisible}
        numericCols={Playlist.numericCols}
        textColumns={Playlist.textColumns}
        gridColumns={{
          cols: [
            Playlist.textColumns[0],
            Playlist.textColumns[1],
            Playlist.textColumns[5],
          ],
        }}
        play={playTrack}
        queue={queueTrack}
      />
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
              spotifyApi
            ) {
              spotifyApi.getMyCurrentPlaybackState().then((playbackState) => {
                if (
                  playbackState.context?.uri ===
                  `spotify:playlist:${spotifyState.queuePlaylist}`
                ) {
                  console.log(`removing ${state.track.uri} from quu`);
                  spotifyApi.removeTracksFromPlaylist(
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

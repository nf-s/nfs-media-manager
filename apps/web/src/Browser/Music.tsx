import axios from "axios";
import React, { useCallback, useEffect, useState } from "react";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { CleanAlbum, CleanLibrary, CleanTrack } from "data-types";
import { useTraceUpdate } from "../Common/util.js";
import {
  dataCols,
  defaultSort,
  defaultVisible,
  gridCols,
} from "../Models/Album.jsx";
import * as Playlist from "../Models/Playlist.jsx";
import Browser from "./Browser.jsx";
import { getQueuePlaylistId } from "./Spotify.js";

function Music(props: {
  spotifyToken: string;
  darkMode: boolean;
  mode: "albums" | "playlist";
}) {
  useTraceUpdate(props);
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [deviceId, setDeviceId] = useState<{ id?: string }>({});
  console.log(deviceId);

  const [playerState, setSpotifyPlayer] = useState<{
    uris?: string | string[];
    play?: boolean;
    waitForPlay?: boolean;
  }>({ play: true });

  const [spotifyState, setSpotifyUser] = useState<{
    id: string;
    queuePlaylist: string | undefined;
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
    const spotifyApi = new SpotifyWebApi.default();
    spotifyApi.setAccessToken(props.spotifyToken);

    setSpotifyApi({ api: spotifyApi });
  }, [props.spotifyToken]);

  useEffect(() => {
    const fetchData = async () => {
      const result = await axios.default("/lib-music.json");

      const library = result.data as CleanLibrary;

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
  }, []);

  useEffect(() => {
    const fetchSpotifyUser = async () => {
      if (!spotify) return;
      const user = await spotify.api.getMe();

      const playlistId = await getQueuePlaylistId(spotify.api, user.id);

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
          tag={"album"}
          rows={rowData.rows}
          defaultSort={defaultSort}
          defaultVisible={defaultVisible}
          dataColumns={dataCols}
          gridColumns={gridCols}
          GridButtons={AlbumButtons(queueAlbum, playAlbum)}
          customColumns={[
            {
              key: "Controls",
              name: "",
              renderCell: (formatterProps: { row: CleanAlbum }) => (
                <>
                  <button
                    onClick={(evt) => {
                      queueAlbum(formatterProps.row);
                      evt.stopPropagation();
                    }}
                  >
                    +
                  </button>
                  <button
                    onClick={(evt) => {
                      playAlbum(formatterProps.row);
                      evt.stopPropagation();
                    }}
                  >
                    &#9654;
                  </button>
                </>
              ),
              width: 80,
              resizable: false,
            },
          ]}
        />
      ) : (
        <Browser
          tag={"playlist"}
          rows={playlistData.rows}
          defaultSort={Playlist.defaultSort}
          defaultVisible={Playlist.defaultVisible}
          dataColumns={Playlist.dataColumns}
          gridColumns={{
            width: 250,
            height: 250,
            cols: ["title", "artists", "dateReleased"],
          }}
          customColumns={[
            {
              key: "Controls",
              name: "",
              renderCell: (formatterProps: { row: CleanTrack }) => (
                <>
                  <button onClick={() => queueTrack(formatterProps.row)}>
                    +
                  </button>
                  <button onClick={() => playTrack(formatterProps.row)}>
                    &#9654;
                  </button>
                </>
              ),
              width: 80,
              resizable: false,
            },
          ]}
        />
      )}

      <div className={"player"}>
        <SpotifyPlayer
          name="Nick's Web Player"
          persistDeviceSelection={true}
          showSaveIcon={true}
          token={props.spotifyToken}
          callback={(state: any) => {
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

const AlbumButtons: (
  queue: (row: CleanAlbum) => void,
  play: (row: CleanAlbum) => void
) => React.FC<{ row: CleanAlbum }> = (queue, play) => (props) => {
  return (
    <div className="image-buttons">
      {queue ? (
        <button
          onClick={(evt) => {
            queue(props.row);
            evt.stopPropagation();
          }}
        >
          +
        </button>
      ) : null}
      {play ? (
        <button
          onClick={(evt) => {
            play(props.row);
            evt.stopPropagation();
          }}
        >
          &#9654;
        </button>
      ) : null}
    </div>
  );
};

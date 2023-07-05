import { CleanAlbum, CleanLibrary } from "data-types";
import React, { useContext, useEffect, useState } from "react";
import SpotifyPlayer from "react-spotify-web-playback";
import { useTraceUpdate } from "../Common/util.js";
import * as Album from "../Models/Album.jsx";
import * as Playlist from "../Models/Playlist.jsx";
import Browser from "./Browser.jsx";
import { SpotifyContext, SpotifyDispatchContext } from "./SpotifyContext.js";

function Music(props: { darkMode: boolean; mode: "albums" | "playlist" }) {
  useTraceUpdate(props);

  const spotifyContext = useContext(SpotifyContext);
  const spotifyDispatch = useContext(SpotifyDispatchContext);

  const [rowData, setData] = useState<{
    rows: CleanAlbum[];
  }>({ rows: [] });

  // const [playlistData, setPlaylistData] = useState<{
  //   rows: CleanTrack[];
  // }>({ rows: [] });
  const playlistData = { rows: [] };

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
        {spotifyContext?.authToken ? (
          <SpotifyPlayer
            name="Nick's Web Player"
            showSaveIcon={true}
            token={spotifyContext.authToken}
            callback={(state: any) => {
              if (!spotifyDispatch || !spotifyContext?.api) return;

              if (state.deviceId)
                spotifyDispatch({
                  type: "update",
                  value: { deviceId: state.deviceId },
                });
              if (state.isPlaying)
                spotifyDispatch({
                  type: "update",
                  value: { waitForPlay: false },
                });
              if (!state.isPlaying && spotifyContext.waitForPlay) return;

              if (
                !spotifyContext?.queuePlaylist ||
                state.type !== "track_update"
              )
                return;

              if (!state.isPlaying && state.nextTracks.length === 0) {
                // Hacky way to get my playlist queue to start if there aren't any tracks to play
                spotifyDispatch({
                  type: "update",
                  value: { uris: [], play: false, waitForPlay: true },
                });
                setTimeout(() => {
                  spotifyDispatch({
                    type: "update",
                    value: {
                      uris: [
                        `spotify:playlist:${spotifyContext!.queuePlaylist}`,
                      ],
                      play: true,
                      waitForPlay: true,
                    },
                  });
                }, 500);
              } else if (
                state.isPlaying &&
                spotifyContext?.uris?.[0] ===
                  `spotify:playlist:${spotifyContext!.queuePlaylist}`
              ) {
                spotifyContext.api
                  .getMyCurrentPlaybackState()
                  .then((playbackState) => {
                    if (
                      spotifyContext.queuePlaylist &&
                      playbackState.context?.uri ===
                        `spotify:playlist:${spotifyContext.queuePlaylist}`
                    ) {
                      spotifyContext.api!.removeTracksFromPlaylist(
                        spotifyContext.queuePlaylist,
                        [state.track.uri]
                      );
                    }
                  });
              }
            }}
            play={spotifyContext?.play}
            uris={spotifyContext?.uris}
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

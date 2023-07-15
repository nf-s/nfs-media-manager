import { CleanAlbum, CleanLibrary } from "data-types";
import React, { useEffect, useState } from "react";
import { useTraceUpdate } from "../Common/util.js";
import * as Album from "../Models/Album.jsx";
import * as Playlist from "../Models/Playlist.jsx";
import Browser from "./Browser.jsx";
import SpotifyPlayer from "./SpotifyPlayer.js";

function Music(props: { darkMode: boolean; mode: "albums" | "playlist" }) {
  useTraceUpdate(props);
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
        await fetch("/data/lib-music.json")
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
    <div className="music-root">
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

      <SpotifyPlayer />
    </div>
  );
}

export default Music;

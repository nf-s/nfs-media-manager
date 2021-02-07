import axios from "axios";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid, { Column, Filters, SortDirection } from "react-data-grid";

import Select from "react-select";
import "react-data-grid/dist/react-data-grid.css";
import { CleanAlbum } from "../../movie-scraper/src/music/clean";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { getQueuePlaylistId } from "./Spotify";

function Music(props: { spotifyToken: string }) {
  const [spotifyApi, setSpotifyApi] = useState<SpotifyWebApi.SpotifyWebApiJs>();
  const [rowData, setData] = useState<{ rows: CleanAlbum[] }>({ rows: [] });
  const [deviceId, setDeviceId] = useState<{ id?: string }>({});
  console.log(deviceId);
  const [playerState, setSpotifyPlayer] = useState<{
    uris?: string | string[];
    play?: boolean;
    waitForPlay?: boolean;
  }>({ play: true });
  const [userState, setSpotifyUser] = useState<{
    id: string;
    queuePlaylist: string;
  }>();
  const [[sortColumn, sortDirection], setSort] = useState<
    [string, SortDirection]
  >(["title", "DESC"]);

  const columns: Column<CleanAlbum>[] = [
    {
      key: "play",
      name: "",
      formatter: (props) => (
        <>
          <button
            onClick={() => {
              setSpotifyPlayer({
                uris: [`spotify:album:${props.row.id}`],
                play: true,
              });
            }}
          >
            Play
          </button>
          <button
            onClick={() =>
              userState?.queuePlaylist && spotifyApi
                ? spotifyApi.addTracksToPlaylist(
                    userState?.queuePlaylist,
                    props.row.tracks.map((id) => `spotify:track:${id}`)
                  )
                : alert("Queue playlist ID not set!")
            }
          >
            Queue
          </button>
        </>
      ),
    },
    { key: "title", name: "Title", sortable: true },
    {
      key: "artist",
      name: "Artist",
      sortable: true,
      filterRenderer: (p) => (
        <div className={"filter-container"}>
          <Select
            value={p.value}
            onChange={p.onChange}
            options={Array.from(new Set(rowData.rows.map((r) => r.artist))).map(
              (d) => ({
                label: d,
                value: d,
              })
            )}
            menuPortalTarget={document.body}
          />
        </div>
      ),
    },
    { key: "dateReleased", name: "Release" },
    { key: "dateAdded", name: "Added" },
  ];

  const [filters, setFilters] = useState<Filters>({
    artist: "",
  });
  const [enableFilterRow, setEnableFilterRow] = useState(true);

  useEffect(() => {
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(props.spotifyToken);

    setSpotifyApi(spotifyApi);
  }, [props.spotifyToken]);

  useEffect(() => {
    const fetchData = async () => {
      const result = await axios("/lib-music.json");

      setData({ rows: result.data });
    };

    fetchData();
  }, []);

  useEffect(() => {
    const fetchSpotifyUser = async () => {
      if (!spotifyApi) return;
      const user = await spotifyApi.getMe();

      let playlistId = await getQueuePlaylistId(spotifyApi, user.id);

      setSpotifyUser({ id: user.id, queuePlaylist: playlistId });
      if (playerState.uris && playerState.uris.length === 0) {
        setSpotifyPlayer({ uris: [`spotify:playlist:${playlistId}`] });
      }
    };

    fetchSpotifyUser();
  }, [playerState, spotifyApi]);

  // useEffect(() => {
  //   getQueuePlaylistId(spotifyApi).then(id => {
  //     if (id) {
  //       console.log(`found playists queue`);
  //     } else {
  //       console.log('CREATE ONE');
  //       spotifyApi.createPlaylist()
  //     }
  //   })
  // }, []);

  const sortedRows = useMemo(() => {
    if (sortDirection === "NONE") return rowData.rows;

    let sortedRows = [...rowData.rows];

    switch (sortColumn) {
      case "title":
      case "artist":
      case "dateReleased":
      case "dateAdded":
        sortedRows = sortedRows.sort((a, b) =>
          (a[sortColumn] ?? "").localeCompare(b[sortColumn] ?? "")
        );
        break;
      default:
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rowData.rows, sortDirection, sortColumn]);

  const filteredRows = useMemo(() => {
    return sortedRows.filter((r) => {
      return filters.artist ? filters.artist.value === r.artist : true;
    });
  }, [sortedRows, filters]);

  function clearFilters() {
    setFilters({
      artist: "",
    });
  }

  function toggleFilters() {
    setEnableFilterRow(!enableFilterRow);
  }

  const handleSort = useCallback(
    (columnKey: string, direction: SortDirection) => {
      setSort([columnKey, direction]);
    },
    []
  );

  return (
    <div className="root-music">
      {/* <div className="header-filters-toolbar">
        <button type="button" onClick={toggleFilters}>
          Toggle Filters
        </button>
        <button type="button" onClick={clearFilters}>
          Clear Filters
        </button>
      </div> */}
      <SpotifyPlayer
        name="Nick's Web Player"
        token={props.spotifyToken}
        callback={(state) => {
          console.log(playerState.uris);
          console.log(state);

          if (state.deviceId) setDeviceId({ id: state.deviceId });
          if (state.isPlaying) playerState.waitForPlay = false;
          if (!state.isPlaying && playerState.waitForPlay) return;

          if (!userState?.queuePlaylist || state.type !== "track_update")
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
                uris: [`spotify:playlist:${userState.queuePlaylist}`],
                play: true,
                waitForPlay: true,
              });
            }, 500);
          } else if (
            state.isPlaying &&
            playerState.uris?.[0] ===
              `spotify:playlist:${userState.queuePlaylist}` &&
            spotifyApi
          ) {
            spotifyApi.getMyCurrentPlaybackState().then((playbackState) => {
              if (
                playbackState.context?.uri ===
                `spotify:playlist:${userState.queuePlaylist}`
              ) {
                console.log(`removing ${state.track.uri} from quu`);
                spotifyApi.removeTracksFromPlaylist(userState.queuePlaylist, [
                  state.track.uri,
                ]);
              }
            });
          }
        }}
        play={playerState.play}
        autoPlay={true}
        persistDeviceSelection={true}
        uris={playerState.uris}
      />
      ;
      <DataGrid
        columns={columns}
        rows={filteredRows}
        // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
        defaultColumnOptions={{
          sortable: true,
          resizable: true,
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        enableFilterRow={enableFilterRow}
        filters={filters}
        onFiltersChange={setFilters}
        className="fill-grid"
      />
    </div>
  );
}

export default Music;

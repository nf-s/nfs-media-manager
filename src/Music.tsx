import axios from "axios";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import "react-data-grid/dist/react-data-grid.css";
import { CleanAlbum } from "../../movie-scraper/src/music/clean";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";

function Music() {
  const [rowData, setData] = useState<{ rows: CleanAlbum[] }>({ rows: [] });
  const [deviceId, setDeviceId] = useState<{ id?: string }>({});
  const [spotifyPlayer, setSpotifyPlayer] = useState<{
    uris?: string | string[];
  }>({});
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
                uris: `spotify:album:${props.row.id}`,
              });
            }}
          >
            Play
          </button>
          <button
            onClick={() =>
              addToQueue(props.row.tracks.map((id) => `spotify:track:${id}`))
            }
          >
            Queue
          </button>
        </>
      ),
    },
    { key: "title", name: "Title", sortable: true },
    { key: "artist", name: "Artist", sortable: true },
    { key: "dateReleased", name: "Release" },
    { key: "dateAdded", name: "Added" },
  ];

  // const [filters, setFilters] = useState<Filters>({
  //   ratingImdbValue: "",
  // });
  // const [enableFilterRow, setEnableFilterRow] = useState(true);

  const addToQueue = async (ids: string[]) => {
    const id = ids.splice(0, 1)[0];
    if (id)
      spotifyApi
        .queue(id)
        .then(() => addToQueue(ids))
        .catch((error) => {
          console.log(`FAILED to queue spotify ID ${id}`);
          console.log(error);
        });
  };

  useEffect(() => {
    const fetchData = async () => {
      const result = await axios("/lib-music.json");

      setData({ rows: result.data });
    };

    fetchData();
  }, []);

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

  // const filteredRows = useMemo(() => {
  //   return sortedRows.filter((r) => {
  //     return filters.ratingImdbValue
  //       ? filters.ratingImdbValue.filterValues(
  //           r,
  //           filters.ratingImdbValue,
  //           "ratingImdbValue"
  //         )
  //       : true;
  //   });
  // }, [sortedRows, filters]);

  // function clearFilters() {
  //   setFilters({
  //     ratingImdbValue: "",
  //   });
  // }

  // function toggleFilters() {
  //   setEnableFilterRow(!enableFilterRow);
  // }

  const handleSort = useCallback(
    (columnKey: string, direction: SortDirection) => {
      setSort([columnKey, direction]);
    },
    []
  );

  const token = "xxx";

  var spotifyApi = new SpotifyWebApi();
  spotifyApi.setAccessToken(token);

  console.log(deviceId);

  return (
    <>
      {/* <div className="header-filters-toolbar">
        <button type="button" onClick={toggleFilters}>
          Toggle Filters
        </button>
        <button type="button" onClick={clearFilters}>
          Clear Filters
        </button>
      </div> */}
      <a href="https://accounts.spotify.com/en/authorize?response_type=token&client_id=adaaf209fb064dfab873a71817029e0d&redirect_uri=https:%2F%2Fdeveloper.spotify.com%2Fdocumentation%2Fweb-playback-sdk%2Fquick-start%2F&scope=streaming%20user-read-email%20user-read-private%20user-library-read%20user-library-modify%20user-read-playback-state%20user-modify-playback-state&show_dialog=true">
        Get token
      </a>
      <SpotifyPlayer
        name="Nick's Web Player"
        token={token}
        callback={(state) => {
          if (state.deviceId) setDeviceId({ id: state.deviceId });
          console.log(spotifyPlayer.uris);
          console.log(state);
        }}
        uris={spotifyPlayer.uris}
      />
      ;
      <DataGrid
        columns={columns}
        rows={sortedRows}
        // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
        defaultColumnOptions={{
          sortable: true,
          resizable: true,
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        // enableFilterRow={enableFilterRow}
        // filters={filters}
        // onFiltersChange={setFilters}
        className="fill-grid"
      />
    </>
  );
}

export default Music;

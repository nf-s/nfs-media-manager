import { GridLayout } from "@egjs/react-infinitegrid";
import axios from "axios";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import "react-data-grid/dist/react-data-grid.css";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select, { OptionsType } from "react-select";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { CleanAlbum } from "../../movie-scraper/src/music/clean";
import config from "./config.json";
import { getQueuePlaylistId } from "./Spotify";

const grid = true;

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

  const play = (row: CleanAlbum) => {
    setSpotifyPlayer({
      uris: [`spotify:album:${row.id.spotify}`],
      play: true,
    });
  };

  const queue = (row: CleanAlbum) => {
    userState?.queuePlaylist && spotifyApi
      ? spotifyApi.addTracksToPlaylist(
          userState?.queuePlaylist,
          row.tracks.map((id) => `spotify:track:${id}`)
        )
      : alert("Queue playlist ID not set!");
  };

  const columns: Column<CleanAlbum>[] = [
    {
      key: "play",
      name: "",
      formatter: (props) => (
        <>
          <button onClick={() => queue(props.row)}>+</button>
          <button
            onClick={() => {
              play(props.row);
            }}
          >
            &#9654;
          </button>
        </>
      ),
    },
    { key: "title", name: "Title", sortable: true },
    {
      key: "artist",
      name: "Artist",
      sortable: true,
    },
    { key: "dateReleased", name: "Release", sortable: true },
    { key: "dateAdded", name: "Added", sortable: true },
    {
      key: "genres",
      name: "Genres",
      formatter: (props) => <span>{props.row.genres.join(", ")}</span>,
    },
  ];

  type Filter = OptionsType<{ label: string; value: string }>;

  const [filters, setFilters] = useState<{
    artists: Filter;
    genres: Filter;
  }>({ artists: [], genres: [] });
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
      case "genres":
        sortedRows = sortedRows.sort((a, b) =>
          a[sortColumn].join(",").localeCompare(b[sortColumn].join(","))
        );
        break;
      default:
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rowData.rows, sortDirection, sortColumn]);

  const filteredRows = useMemo(() => {
    const artists = filters.artists.map((a) => a.value);
    const genres = filters.genres.map((a) => a.value);

    return sortedRows.filter((r) => {
      return artists.length > 0
        ? artists.includes(r.artist)
        : true && genres.length > 0
        ? genres.find((g) => r.genres.includes(g))
        : true;
    });
  }, [sortedRows, filters]);

  function clearFilters() {
    setFilters({
      artists: [],
      genres: [],
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

  function getColumnWithTotals<K extends keyof CleanAlbum>(
    colName: K,
    sort: "key" | "value" = "key"
  ) {
    const total = new Map<string, number>();
    for (let i = 0; i < rowData.rows.length; i++) {
      const value = rowData.rows[i][colName];
      const values =
        typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      for (let j = 0; j < values.length; j++) {
        total.set(values[j], (total.get(values[j]) ?? 0) + 1);
      }
    }

    const result = Array.from(total).sort((a, b) =>
      (a[0] ?? "").localeCompare(b[0] ?? "")
    );

    if (sort === "value") {
      return result.sort((a, b) => a[1] - b[1]);
    }

    return result;
  }

  // function loadItems(start: number) {
  //   const items: React.ReactFragment[] = [];

  //   for (let i = start; i < filteredRows.length; ++i) {
  //     items.push(<div>{filteredRows[i].title}</div>);
  //   }
  //   return items;
  // }
  // const onAppend: (param: OnAppend) => any = ({ startLoading }) => {
  //   const list = imageGrid.list;
  //   const start = list.length;
  //   const items = loadItems(start);

  //   if (startLoading) startLoading();
  //   setImageGrid({ list: list.concat(items) });
  // };
  // const onLayoutComplete: (param: OnLayoutComplete) => any = ({
  //   isLayout,
  //   endLoading,
  // }) => {
  //   !isLayout && endLoading && endLoading();
  // };

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
      <div className="header">
        <Select
          placeholder="Artist"
          className={"filter-select"}
          value={filters.artists}
          isMulti
          onChange={(artists) => {
            setFilters({
              artists,
              genres: filters.genres,
            });
          }}
          options={getColumnWithTotals("artist").map((d) => ({
            label: `${d[0]} (${d[1]})`,
            value: d[0],
          }))}
          isClearable={true}
        />
        <Select
          placeholder="Genre"
          className={"filter-select"}
          value={filters.genres}
          isMulti
          onChange={(genres) => {
            setFilters({
              genres,
              artists: filters.artists,
            });
          }}
          options={getColumnWithTotals("genres").map((d) => ({
            label: `${d[0]} (${d[1]})`,
            value: d[0],
          }))}
          isClearable={true}
        />
        <Select
          isSearchable={false}
          is
          placeholder="Sort"
          className={"filter-select"}
          value={{
            value: sortColumn,
            label:
              columns.find(
                (c) => c.key === sortColumn && typeof c.name === "string"
              )?.name ?? sortColumn,
          }}
          onChange={(sort) => {
            sort?.value &&
              setSort([
                sort?.value,
                sort?.value === sortColumn
                  ? sortDirection === "ASC"
                    ? "DESC"
                    : "ASC"
                  : sortDirection,
              ]);
          }}
          options={columns
            .filter((c) => c.sortable)
            .map((d) => ({
              value: d.key,
              label: typeof d.name === "string" ? d.name : d.key,
            }))}
        />
      </div>
      {!grid ? (
        <div className={"data-grid"}>
          <DataGrid
            columns={columns}
            rows={filteredRows}
            // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
            defaultColumnOptions={{
              resizable: true,
            }}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            className="fill-grid"
          />
        </div>
      ) : (
        <div className={"image-grid"}>
          <div className={"image-grid-container"}>
            <GridLayout
              tag="div"
              options={{
                useRecycle: true,
                isConstantSize: true,
                isEqualSize: true,
              }}
            >
              {filteredRows.map((row, i) => (
                <div key={i} className="image-album">
                  <div className="image-wrapper">
                    <div className="image-buttons-wrapper">
                      <div className="image-buttons">
                        <button onClick={() => queue(row)}>+</button>
                        <button
                          onClick={() => {
                            play(row);
                          }}
                        >
                          &#9654;
                        </button>
                      </div>
                    </div>
                    <LazyLoadImage
                      src={row.art}
                      style={{ width: "250px", height: "250px" }}
                    />
                  </div>

                  <div className="image-album-title">{row.title}</div>
                  <div className="image-album-artist">{row.artist}</div>
                </div>
              ))}
            </GridLayout>
          </div>
        </div>
      )}
      <div className={"player"}>
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
      </div>
    </div>
  );
}

export default Music;

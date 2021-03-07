import { GridLayout } from "@egjs/react-infinitegrid";
import axios from "axios";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import "react-data-grid/dist/react-data-grid.css";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select, { OptionsType } from "react-select";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { PickProperties } from "ts-essentials";
import { CleanAlbum } from "../../movie-scraper/src/music/clean";
import config from "./config.json";
import { getQueuePlaylistId } from "./Spotify";

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return [h, m > 9 ? m : h ? "0" + m : m || "0", s > 9 ? s : "0" + s]
    .filter(Boolean)
    .join(":");
}

function Music(props: { spotifyToken: string }) {
  const [spotifyApi, setSpotifyApi] = useState<SpotifyWebApi.SpotifyWebApiJs>();
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
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
    [keyof CleanAlbum, SortDirection]
  >(["dateAdded", "DESC"]);

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

  type FieldRenderer = (props: { album: CleanAlbum }) => JSX.Element;

  const Numeric = (col: NumericCol) => {
    if (col.key === undefined) return () => <></>;
    const max =
      col.max === null
        ? null
        : col.max ?? Math.max(...rowData.rows.map((r) => r[col.key] ?? 0));

    return (props: { album: CleanAlbum }) =>
      max === null ? (
        <>
          {(props.album[col.key]! * (col.mult ?? 1)).toFixed(col.precision)}
          {col.append}
        </>
      ) : (
        <>
          {(((props.album[col.key] ?? 0) * (col.mult ?? 1)) / max!).toFixed(
            col.precision
          )}
          {col.append}
        </>
      );
  };
  const Generic = (key: keyof CleanAlbum) => (props: { album: CleanAlbum }) => (
    <>{props.album[key]}</>
  );

  const Genres: FieldRenderer = (props: { album: CleanAlbum }) => {
    const setGenreFilter = (genre: string) => {
      setFilters({
        ...filters,
        genres: !filters.genres.find((a) => a.value === genre)
          ? [...filters.genres, { value: genre, label: genre }]
          : filters.genres,
      });
    };

    return (
      <>
        {props.album.genres.map((g, i) => (
          <a onClick={() => setGenreFilter(g)}>
            {g}
            {i < props.album.genres.length - 1 ? ", " : ""}
          </a>
        ))}
      </>
    );
  };

  const Artist: FieldRenderer = (props: { album: CleanAlbum }) => (
    <a
      onClick={() =>
        setFilters({
          ...filters,
          artists: !filters.artists.find((a) => a.value === props.album.artist)
            ? [
                ...filters.artists,
                { value: props.album.artist, label: props.album.artist },
              ]
            : filters.artists,
        })
      }
    >
      {props.album.artist}
    </a>
  );

  const Title: FieldRenderer = (props: { album: CleanAlbum }) => (
    <a
      href={`https://open.spotify.com/album/${props.album.id.spotify}`}
      title={props.album.title}
      target="blank"
    >
      {props.album.title}
    </a>
  );

  type NumericCol = {
    key: keyof PickProperties<CleanAlbum, number | undefined> & string;
    name: string;
    max: number | null | undefined;
    append: string;
    precision: number;
    mult: number | undefined;
  };

  const numericCols: NumericCol[] = [
    {
      key: "ratingDiscogsVotes",
      name: "Discogs Votes",
      max: null,
      append: "",
      mult: 1,
      precision: 0,
    },
    {
      key: "ratingDiscogsValue",
      name: "Discogs Rating",
      max: 5,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "popularityDiscogs",
      name: "Discogs Popularity",
      max: undefined,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "popularitySpotify",
      name: "Spotify Popularity",
      max: 100,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "acousticness",
      name: "Acousticness",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "danceability",
      name: "Danceability",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "energy",
      name: "Energy",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "instrumentalness",
      name: "Intrumentalness",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "liveness",
      name: "Liveness",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      key: "loudness",
      name: "Loudness",
      max: null,
      append: "dB",
      mult: 1,
      precision: 1,
    },
    { key: "mode", name: "Mode", max: 1, append: "%", mult: 100, precision: 1 },
    {
      key: "speechiness",
      name: "Speechiness",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    { key: "tempo", name: "BPM", max: null, append: "", mult: 1, precision: 1 },
    {
      key: "valence",
      name: "Valence",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
  ];

  type ColumnWithFieldRenderer = Column<CleanAlbum> & {
    fieldRenderer?: FieldRenderer;
  };

  const columns: ColumnWithFieldRenderer[] = [
    {
      key: "Spotify Controls",
      name: "",
      formatter: (props: { row: CleanAlbum }) => (
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
      width: 80,
      resizable: false,
    },
    {
      key: "title",
      name: "Title",
      sortable: true,
      fieldRenderer: Title,
    },
    {
      key: "artist",
      name: "Artist",
      sortable: true,
      fieldRenderer: Artist,
    },
    {
      key: "durationSec",
      name: "Duration",
      sortable: true,
      fieldRenderer: ((props) => (
        <>{formatTime(props.album.durationSec)}</>
      )) as FieldRenderer,
      width: 80,
    },
    {
      key: "dateReleased",
      name: "Release",
      sortable: true,
      width: 100,
      resizable: false,
    },
    {
      key: "dateAdded",
      name: "Added",
      sortable: true,
      width: 100,
      resizable: false,
    },
    {
      key: "genres",
      name: "Genres",
      fieldRenderer: Genres,
    },
    ...numericCols.map((col) => ({
      key: col.key,
      name: col.name !== "" ? col.name : col.key,
      sortable: true,
      resizable: false,
      width: 80,
      fieldRenderer: Numeric(col),
    })),
  ]
    // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
    .map((col: ColumnWithFieldRenderer) => {
      if (col.fieldRenderer && !col.formatter) {
        col.formatter = (props) => col.fieldRenderer!({ album: props.row });
      }
      return col;
    });

  const defaultVisible = [
    "Spotify Controls",
    "title",
    "artist",
    "durationSec",
    "dateReleased",
    "dateAdded",
    "genres",
  ];

  const [visibleColumns, setVisibleColumns] = useState<Column<CleanAlbum>[]>(
    columns.filter((c) => defaultVisible.includes(c.key))
  );

  type SelectValues = OptionsType<{ label: string; value: string }>;

  const [filters, setFilters] = useState<{
    artists: SelectValues;
    genres: SelectValues;
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
        const numericColKey = numericCols.find((col) => col.key === sortColumn)
          ?.key;
        if (numericColKey) {
          sortedRows = sortedRows
            .filter((a) => (a as any)[numericColKey] !== undefined)
            .sort(
              (a, b) => (a as any)[numericColKey] - (b as any)[numericColKey]
            );
        }
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
      setSort([columnKey as keyof CleanAlbum, direction]);
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
        <button
          type="button"
          onClick={() => setViewMode(viewMode === "grid" ? "table" : "grid")}
        >
          {viewMode === "grid" ? "Table" : "Grid"}
        </button>
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
          theme={(theme) => ({
            ...theme,
            colors: {
              ...theme.colors,
              primary25: "#00ffab24",
              primary50: "#00ffab50",
              primary75: "#00ffab",
              primary: "#00c583",
            },
          })}
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
          theme={(theme) => ({
            ...theme,
            colors: {
              ...theme.colors,
              primary25: "#00ffab24",
              primary50: "#00ffab50",
              primary75: "#00ffab",
              primary: "#00c583",
            },
          })}
        />
        <div>
          <Select
            placeholder="Sort"
            className={"filter-select sort-select"}
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
                value: d.key as keyof CleanAlbum,
                label: typeof d.name === "string" ? d.name : d.key,
              }))}
            theme={(theme) => ({
              ...theme,
              colors: {
                ...theme.colors,
                primary25: "#00ffab24",
                primary50: "#00ffab50",
                primary75: "#00ffab",
                primary: "#00c583",
              },
            })}
          />
          <a
            className="reverse-sort"
            onClick={() =>
              setSort([sortColumn, sortDirection === "ASC" ? "DESC" : "ASC"])
            }
          >
            &#8597;
          </a>
        </div>

        {viewMode === "table" ? (
          <Select
            controlShouldRenderValue={false}
            closeMenuOnSelect={false}
            isMulti
            hideSelectedOptions={false}
            isClearable={false}
            placeholder="Columns"
            className={"filter-select"}
            value={visibleColumns.map((col) => ({
              value: col.key,
              label:
                typeof col.name === "string" && col.name !== ""
                  ? col.name
                  : col.key,
            }))}
            onChange={(selectedCols) => {
              setVisibleColumns(
                columns.filter((col) =>
                  selectedCols.find((c) => c.value === col.key)
                )
              );
            }}
            options={columns.map((col) => ({
              value: col.key,
              label:
                typeof col.name === "string" && col.name !== ""
                  ? col.name
                  : col.key,
            }))}
            theme={(theme) => ({
              ...theme,
              colors: {
                ...theme.colors,
                primary25: "#00ffab24",
                primary50: "#00ffab50",
                primary75: "#00ffab",
                primary: "#00c583",
              },
            })}
          />
        ) : null}
      </div>
      {viewMode === "table" ? (
        <div className={"data-grid"}>
          <DataGrid
            columns={visibleColumns}
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
                <div key={i} className="image-album" style={{ width: 250 }}>
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

                  <div className="image-album-title">
                    <Title album={row}></Title>
                  </div>
                  <div className="image-album-artist">
                    <Artist album={row}></Artist>
                  </div>
                  <div className="image-album-extra">
                    <Genres album={row}></Genres>
                  </div>
                  {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
                  <div className="image-album-extra">
                    {!["genre", "artist", "title"].includes(sortColumn)
                      ? // Use column `fieldRenderer` if it exists, otherwise use Generic
                        (
                          columns.find((col) => col.key === sortColumn)
                            ?.fieldRenderer ?? Generic(sortColumn)
                        )({ album: row })
                      : null}
                  </div>
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

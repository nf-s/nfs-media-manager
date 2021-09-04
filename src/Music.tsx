import { GridLayout } from "@egjs/react-infinitegrid";
import axios from "axios";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select, { OptionsType } from "react-select";
import SpotifyPlayer from "react-spotify-web-playback";
import SpotifyWebApi from "spotify-web-api-js";
import { CleanAlbum } from "../../movie-scraper/src/music/clean";
import config from "./config.json";
import { getQueuePlaylistId } from "./Spotify";
import {
  Artist,
  defaultSort,
  defaultVisible,
  FieldRenderer,
  Generic,
  Genres,
  getColumnWithTotals,
  Numeric,
  numericCols,
  textColumns,
  Title,
} from "./Table/Columns";

export type FilterValue = {
  label: string;
  value: string;
  field: keyof CleanAlbum;
};

type SelectValues = OptionsType<FilterValue>;

type ColumnWithFieldRenderer = Column<CleanAlbum> & {
  fieldRenderer?: FieldRenderer;
};

function Music(props: { spotifyToken: string }) {
  const [spotifyApi, setSpotifyApi] = useState<SpotifyWebApi.SpotifyWebApiJs>();
  const [rowData, setData] = useState<{
    rows: CleanAlbum[];
    filters: FilterValue[];
  }>({ rows: [], filters: [] });
  const [columns, setColumns] = useState<ColumnWithFieldRenderer[]>([]);
  const [deviceId, setDeviceId] = useState<{ id?: string }>({});

  const [playerState, setSpotifyPlayer] = useState<{
    uris?: string | string[];
    play?: boolean;
    waitForPlay?: boolean;
  }>({ play: true });

  const [spotifyState, setSpotifyUser] =
    useState<{
      id: string;
      queuePlaylist: string;
    }>();

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem("viewMode") as any) ?? "grid"
  );

  const [[sortColumn, sortDirection], setSort] = useState<
    [keyof CleanAlbum, SortDirection]
  >(
    localStorage.getItem("sortColumn") && localStorage.getItem("sortDirection")
      ? ([
          localStorage.getItem("sortColumn"),
          localStorage.getItem("sortDirection"),
        ] as any)
      : defaultSort
  );

  // Default value is set in fetchData
  const [visibleColumns, setVisibleColumns] = useState<Column<CleanAlbum>[]>();

  // Default value is set in fetchData
  function reducer(
    state: SelectValues | undefined,
    action:
      | { type: "add"; field: keyof CleanAlbum; value: string }
      | { type: "clear" }
      | { type: "set"; values: SelectValues }
  ): SelectValues | undefined {
    switch (action.type) {
      case "add":
        const found = rowData.filters.find(
          (a) => a.field === action.field && a.value === action.value
        );
        if (found) {
          return Array.from(new Set([...(state ?? []), found]));
        }
        return state;
      case "set":
        return action.values;
      case "clear":
        return [];
    }
  }

  const [activeFilters, setActiveFilters] = useReducer(reducer, undefined);

  const play = (row: CleanAlbum) => {
    setSpotifyPlayer({
      uris: [`spotify:album:${row.id.spotify}`],
      play: true,
    });
  };

  const queue = useCallback(
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

  const addFilter = (field: keyof CleanAlbum, value: string) => {
    setActiveFilters({ type: "add", field, value });
  };

  useEffect(() => {
    // storing input name
    localStorage.setItem("viewMode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    // storing input name
    localStorage.setItem("sortColumn", sortColumn);
  }, [sortColumn]);

  useEffect(() => {
    // storing input name
    localStorage.setItem("sortDirection", sortDirection);
  }, [sortDirection]);

  useEffect(() => {
    if (!visibleColumns) return;
    // storing input name
    localStorage.setItem(
      "visibleColumns",
      JSON.stringify(visibleColumns.map((col) => col.key))
    );
  }, [visibleColumns]);

  useEffect(() => {
    if (!activeFilters) return;
    // storing input name
    localStorage.setItem("activeFilters", JSON.stringify(activeFilters));
  }, [activeFilters]);

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

      const filters = [
        ...getColumnWithTotals(rows, "artist"),
        ...getColumnWithTotals(rows, "genres"),
      ];

      const savedActiveFilters = JSON.parse(
        localStorage.getItem("activeFilters") ?? ""
      );
      if (Array.isArray(savedActiveFilters)) {
        setActiveFilters({
          type: "set",
          values: filters.filter((a) =>
            savedActiveFilters.find(
              (b) => a.field === b.field && a.value === b.value
            )
          ),
        });
      }

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
        filters,
      });
    };

    fetchData();
  }, []);

  useEffect(() => {
    const maximums = numericCols.reduce<{ [key: string]: number }>(
      (maxs, numCol) => {
        maxs[numCol.key] = Math.max(
          ...rowData.rows.map((r) => r[numCol.key] ?? 0)
        );
        return maxs;
      },
      {}
    );

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
      ...textColumns,
      ...numericCols.map((col) => {
        if (col.generateMaximumFromData) {
          col.max = maximums[col.key];
        }
        return {
          key: col.key,
          name: col.name !== "" ? col.name : col.key,
          sortable: true,
          resizable: false,
          width: 80,
          fieldRenderer: Numeric(col),
        };
      }),
    ]
      // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
      .map((col: ColumnWithFieldRenderer) => {
        if (col.fieldRenderer && !col.formatter) {
          col.formatter = (props) =>
            col.fieldRenderer!({
              album: props.row,
              addFilter,
            });
        }
        return col;
      });

    const savedVisibleColumns = JSON.parse(
      localStorage.getItem("visibleColumns") ?? ""
    );
    if (Array.isArray(savedVisibleColumns)) {
      setVisibleColumns(
        columns.filter((c) => savedVisibleColumns.includes(c.key))
      );
    } else {
      setVisibleColumns(columns.filter((c) => defaultVisible.includes(c.key)));
    }

    setColumns(columns);
  }, [rowData, queue]);

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

  const sortedRows = useMemo(() => {
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
        const numericColKey = numericCols.find(
          (col) => col.key === sortColumn
        )?.key;
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
    const artists = activeFilters
      ?.filter((a) => a.field === "artist")
      .map((a) => a.value);
    const genres = activeFilters
      ?.filter((a) => a.field === "genres")
      .map((a) => a.value);

    return sortedRows.filter((r) => {
      return artists && artists.length > 0
        ? artists.includes(r.artist)
        : true && genres && genres.length > 0
        ? genres.find((g) => r.genres.includes(g))
        : true;
    });
  }, [sortedRows, activeFilters]);

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
      <div className="header">
        <button
          type="button"
          onClick={() => setViewMode(viewMode === "grid" ? "table" : "grid")}
        >
          {viewMode === "grid" ? "Table" : "Grid"}
        </button>
        <Select
          placeholder="Filter"
          className={"filter-select"}
          value={activeFilters}
          isMulti
          onChange={(filter) => {
            setActiveFilters({ type: "set", values: filter });
          }}
          options={rowData.filters}
          isClearable={true}
          closeMenuOnSelect={false}
          styles={{
            valueContainer: (base, props) => ({
              ...base,
              maxHeight: "36px",
              ":hover": { maxHeight: "none" },
            }),
            multiValue: (styles, { data }) => {
              const color =
                data.field === "artist"
                  ? "rgba(255,0,0,.3)"
                  : "rgba(0,0,255,.3)";
              return {
                ...styles,
                backgroundColor: color,
              };
            },
            // multiValueLabel: (styles, { data }) => ({
            //   ...styles,
            //   color: data.color,
            // }),
            // multiValueRemove: (styles, { data }) => ({
            //   ...styles,
            //   color: data.color,
            //   ':hover': {
            //     backgroundColor: data.color,
            //     color: 'white',
            //   },
            // })
          }}
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

        {viewMode === "grid" ? (
          <div>
            <Select
              closeMenuOnSelect={false}
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
        ) : null}

        {viewMode === "table" ? (
          <Select
            controlShouldRenderValue={false}
            closeMenuOnSelect={false}
            isMulti
            hideSelectedOptions={false}
            isClearable={false}
            placeholder="Columns"
            className={"filter-select"}
            value={(visibleColumns ?? []).map((col) => ({
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
            columns={visibleColumns ?? []}
            rows={filteredRows}
            // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
            defaultColumnOptions={{
              resizable: true,
            }}
            sortColumns={[
              {
                columnKey: sortColumn,
                direction: sortDirection,
              },
            ]}
            onSortColumnsChange={(sortColumns) =>
              typeof sortColumns[0] !== "undefined"
                ? setSort([
                    sortColumns[0].columnKey as keyof CleanAlbum,
                    sortColumns[0].direction,
                  ])
                : setSort(defaultSort)
            }
            className="fill-grid"
            onRowClick={(e) => console.log(e)}
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
                    <Title album={row} addFilter={addFilter}></Title>
                  </div>
                  <div className="image-album-artist">
                    <Artist album={row} addFilter={addFilter}></Artist>
                  </div>
                  <div className="image-album-extra">
                    <Genres album={row} addFilter={addFilter}></Genres>
                  </div>
                  {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
                  <div className="image-album-extra">
                    {!["genre", "artist", "title"].includes(sortColumn)
                      ? // Use column `fieldRenderer` if it exists, otherwise use Generic
                        (
                          columns.find((col) => col.key === sortColumn)
                            ?.fieldRenderer ?? Generic(sortColumn)
                        )({ album: row, addFilter })
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

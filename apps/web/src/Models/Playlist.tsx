import { CleanTrack } from "data-types";
import React, { useContext } from "react";
import { ColumnFieldRenderer } from "../Table/FieldRenderer.js";
import { ColumnsConfig } from "../Table/ColumnState.js";
import { formatTime } from "../Table/Columns.jsx";
import { FilterStateContext, addFilter } from "../Table/FilterState.js";

export const Genres: ColumnFieldRenderer<CleanTrack> = (props) => {
  const filterState = useContext(FilterStateContext);

  if (!filterState) return null;
  return (
    <>
      {props.data.genres.map((g, i) => (
        <a
          onClick={() => addFilter(filterState, { field: "genres", value: g })}
          key={`${props.data.spotifyId}-${g}`}
        >
          {g}
          {i < props.data.genres.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Artist: ColumnFieldRenderer<CleanTrack> = (props) => {
  const filterState = useContext(FilterStateContext);

  if (!filterState) return null;
  return (
    <>
      {props.data.artists.map((a, i) => (
        <a
          onClick={() => addFilter(filterState, { field: "artists", value: a })}
          key={`${props.data.spotifyId}-${a}`}
        >
          {a}
          {i < props.data.artists.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

// const keyMap = [
//   "C",
//   "C#/Db",
//   "D",
//   "D#/Eb",
//   "E",
//   "F",
//   "F#/Gb",
//   "G",
//   "G#/Ab",
//   "A",
//   "A#/Bb",
//   "B",
// ];

const camelotKeyMap = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

export const Key: ColumnFieldRenderer<CleanTrack> = (props) => {
  return (
    // Major is represented by 1 and minor is 0
    <>
      {typeof props.data.key !== "undefined"
        ? `${camelotKeyMap[props.data.key]} ${props.data.mode ? "B" : "A"}`
        : ""}
    </>
  );
};

export const columnsConfig: ColumnsConfig<CleanTrack> = {
  id: "spotifyId",
  data: [
    {
      type: "string",
      key: "title",
      name: "Title",
      sortable: true,
    },
    {
      type: "string",
      key: "durationSec",
      name: "Duration",
      sortable: true,
      fieldRenderer: (props) => <>{formatTime(props.data.durationSec)}</>,
      width: 80,
    },
    {
      type: "string",
      key: "artists",
      name: "Artist",
      sortable: true,
      fieldRenderer: Artist,
    },
    {
      type: "string",
      key: "dateReleased",
      name: "Release",
      sortable: true,
      width: 100,
      resizable: false,
    },
    {
      type: "string",
      key: "dateAdded",
      name: "Added",
      sortable: true,
      width: 100,
      resizable: false,
    },
    { type: "string", key: "genres", name: "Genres", fieldRenderer: Genres },
    { type: "string", key: "key", name: "Key", fieldRenderer: Key },
    {
      type: "numeric",
      key: "acousticness",
      name: "Acousticness",
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "danceability",
      name: "Danceability",
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "energy",
      name: "Energy",
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "instrumentalness",
      name: "Intrumentalness",
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "liveness",
      name: "Liveness",
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "loudness",
      name: "Loudness",
      append: "dB",
      precision: 1,
    },
    {
      type: "numeric",
      key: "mode",
      name: "Mode",
      max: 1,
      append: "%",
      mult: 100,
      precision: 1,
    },
    {
      type: "numeric",
      key: "speechiness",
      name: "Speechiness",
      append: "%",
      mult: 100,
      precision: 1,
    },
    { type: "numeric", key: "tempo", name: "BPM", append: "", precision: 1 },
    {
      type: "numeric",
      key: "valence",
      name: "Valence",
      append: "%",
      mult: 100,
      precision: 1,
    },
  ],
  custom: [
    {
      key: "Controls",
      name: "",
      renderCell: (formatterProps: { row: CleanTrack }) => (
        <>
          {/* <button onClick={() => queueTrack(formatterProps.row)}>
            +
          </button>
          <button onClick={() => playTrack(formatterProps.row)}>
            &#9654;
          </button> */}
        </>
      ),
      width: 80,
      resizable: false,
    },
  ],
  grid: {
    width: 250,
    height: 250,
    cols: ["title", "artists", "dateReleased"],
  },
  defaultVisible: [
    "Controls",
    "title",
    "durationSec",
    "artists",
    "dateReleased",
    "dateAdded",
    "genres",
  ],
  defaultSort: ["dateAdded", "DESC"],
};

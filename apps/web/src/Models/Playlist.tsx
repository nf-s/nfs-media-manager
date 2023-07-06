import { CleanTrack } from "data-types";
import React from "react";
import { ColumnsConfig } from "../Table/ColumnState.js";
import { RenderCell, formatTime } from "../Table/Columns.jsx";

export const Genres: RenderCell<CleanTrack> = (props) => {
  return (
    <>
      {props.row.genres.map((g, i) => (
        <a
          // onClick={() => props.addFilter("genres", g)}
          key={`${props.row.spotifyId}-${g}`}
        >
          {g}
          {i < props.row.genres.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Artist: RenderCell<CleanTrack> = (props) => {
  return (
    <>
      {props.row.artists.map((a, i) => (
        <a
          // onClick={() => props.addFilter("artists", a)}
          key={`${props.row.spotifyId}-${a}`}
        >
          {a}
          {i < props.row.artists.length - 1 ? ", " : ""}
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

export const Key: RenderCell<CleanTrack> = (props) => {
  return (
    // Major is represented by 1 and minor is 0
    <>
      {typeof props.row.key !== "undefined"
        ? `${camelotKeyMap[props.row.key]} ${props.row.mode ? "B" : "A"}`
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
      type: "numeric",
      key: "durationSec",
      name: "Duration",
      sortable: true,
      renderCell: (props) => <>{formatTime(props.row.durationSec)}</>,
      width: 80,
    },
    {
      type: "string",
      key: "artists",
      name: "Artist",
      sortable: true,
      renderCell: Artist,
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
    { type: "string", key: "genres", name: "Genres", renderCell: Genres },
    { type: "string", key: "key", name: "Key", renderCell: Key },
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
      renderCell: (props) => (
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

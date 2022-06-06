import React from "react";
import { CleanTrack } from "../../../movie-scraper/src/music/interfaces";
import {
  FieldRenderer,
  DefaultSort,
  DefaultVisible,
  NumericCol,
  StringCol,
  formatTime,
  DataColumn,
} from "./Columns";

export const Genres: FieldRenderer<CleanTrack> = (props) => {
  return (
    <>
      {props.data.genres.map((g, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("genres", g)}
          key={`${props.data.spotifyId}-${g}`}
        >
          {g}
          {i < props.data.genres.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Artist: FieldRenderer<CleanTrack> = (props) => {
  return (
    <>
      {props.data.artists.map((a, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("artists", a)}
          key={`${props.data.spotifyId}-${a}`}
        >
          {a}
          {i < props.data.artists.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

const keyMap = [
  "C",
  "C#/Db",
  "D",
  "D#/Eb",
  "E",
  "F",
  "F#/Gb",
  "G",
  "G#/Ab",
  "A",
  "A#/Bb",
  "B",
];

const camelotKeyMap = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

export const Key: FieldRenderer<CleanTrack> = (props) => {
  return (
    // Major is represented by 1 and minor is 0
    <>
      {typeof props.data.key !== "undefined"
        ? `${camelotKeyMap[props.data.key]} ${props.data.mode ? "B" : "A"}`
        : ""}
    </>
  );
};

export const defaultSort: DefaultSort<CleanTrack> = ["dateAdded", "DESC"];
export const defaultVisible: DefaultVisible<CleanTrack> = [
  "Controls",
  "title",
  "durationSec",
  "artists",
  "dateReleased",
  "dateAdded",
  "genres",
];

export const dataColumns: DataColumn<CleanTrack>[] = [
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
    fieldRenderer: ((props) => (
      <>{formatTime(props.data.durationSec)}</>
    )) as FieldRenderer<CleanTrack>,
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
];

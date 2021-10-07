import React from "react";
import { CleanTrack } from "../../../movie-scraper/src/music/interfaces";
import {
  FieldRenderer,
  DefaultSort,
  DefaultVisible,
  NumericCol,
  StringCol,
  formatTime,
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

export const numericCols: NumericCol<CleanTrack>[] = [
  {
    key: "acousticness",
    name: "Acousticness",
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "danceability",
    name: "Danceability",
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "energy",
    name: "Energy",
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "instrumentalness",
    name: "Intrumentalness",
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "liveness",
    name: "Liveness",
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "loudness",
    name: "Loudness",
    append: "dB",
    precision: 1,
  },
  { key: "mode", name: "Mode", max: 1, append: "%", mult: 100, precision: 1 },
  {
    key: "speechiness",
    name: "Speechiness",
    append: "%",
    mult: 100,
    precision: 1,
  },
  { key: "tempo", name: "BPM", append: "", precision: 1 },
  {
    key: "valence",
    name: "Valence",
    append: "%",
    mult: 100,
    precision: 1,
  },
];
export const textColumns: StringCol<CleanTrack>[] = [
  {
    key: "title",
    name: "Title",
    sortable: true,
  },
  {
    key: "durationSec",
    name: "Duration",
    sortable: true,
    fieldRenderer: ((props) => (
      <>{formatTime(props.data.durationSec)}</>
    )) as FieldRenderer<CleanTrack>,
    width: 80,
  },
  {
    key: "artists",
    name: "Artist",
    sortable: true,
    fieldRenderer: Artist,
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
];

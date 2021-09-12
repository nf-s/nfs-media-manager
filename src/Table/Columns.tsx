import React from "react";
import { SortDirection } from "react-data-grid";
import { PickProperties } from "ts-essentials";
import { CleanAlbum } from "../../../movie-scraper/src/music/clean";
import { FilterValue } from "../Music";

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return [h, m > 9 ? m : h ? "0" + m : m || "0", s > 9 ? s : "0" + s]
    .filter(Boolean)
    .join(":");
}

export type FieldRenderer = (props: {
  album: CleanAlbum;
  addFilter: (field: keyof CleanAlbum, value: string) => void;
}) => JSX.Element;

export const Numeric = (col: NumericCol) => {
  if (col.key === undefined) return () => <></>;

  return (props: { album: CleanAlbum }) => (
    <>
      {(
        ((props.album[col.key] ?? 0) * (col.mult ?? 1)) /
        (col.max ?? 1)
      ).toFixed(col.precision)}
      {col.append}
    </>
  );
};
export const Generic =
  (key: keyof CleanAlbum) => (props: { album: CleanAlbum }) =>
    <>{props.album[key]}</>;

export const Genres: FieldRenderer = (props) => {
  return (
    <>
      {props.album.genres.map((g, i) => (
        <a onClick={() => props.addFilter("genres", g)}>
          {g}
          {i < props.album.genres.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Artist: FieldRenderer = (props) => (
  <a onClick={() => props.addFilter("artist", props.album.artist)}>
    {props.album.artist}
  </a>
);

export const Title: FieldRenderer = (props) => (
  <>
    <a
      href={`https://open.spotify.com/album/${props.album.id.spotify}`}
      title={props.album.title}
      target="blank"
    >
      {props.album.title}
    </a>
    {props.album.links.rym ? (
      <a
        href={props.album.links.rym}
        title={props.album.otherTitles.rym}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/sonemic.png" width="16px" />
      </a>
    ) : null}
    {props.album.links.discogs ? (
      <a
        href={props.album.links.discogs}
        title={props.album.otherTitles.discogs}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/discogs.png" width="16px" />
      </a>
    ) : null}
    {props.album.links.mb ? (
      <a
        href={props.album.links.mb}
        title={props.album.otherTitles.mb}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/mb.png" width="16px" />
      </a>
    ) : null}

    {props.album.links.lastfm ? (
      <a
        href={props.album.links.lastfm}
        title={props.album.otherTitles.lastfm}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/lastfm.png" width="16px" />
      </a>
    ) : null}

    {props.album.links.mc ? (
      <a
        href={props.album.links.mc}
        title={props.album.otherTitles.mc}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/metacritic.svg" width="16px" />
      </a>
    ) : null}
  </>
);

export const defaultSort: [keyof CleanAlbum, SortDirection] = [
  "dateAdded",
  "DESC",
];

export const defaultVisible: (keyof CleanAlbum | "Spotify Controls")[] = [
  "Spotify Controls",
  "title",
  "artist",
  "durationSec",
  "dateReleased",
  "dateAdded",
  "genres",
  "ratingRymValue",
  "ratingRymVotes",
];

export type NumericCol = {
  key: keyof PickProperties<CleanAlbum, number | undefined> & string;
  name: string;
  max?: number | undefined;
  generateMaximumFromData?: boolean;
  append: string;
  precision: number;
  mult?: number | undefined;
};

export const numericCols: NumericCol[] = [
  {
    key: "scrobbles",
    name: "Scrobbles",
    append: "",
    precision: 0,
  },
  {
    key: "ratingRymVotes",
    name: "RYM Votes",
    append: "",
    precision: 0,
  },
  {
    key: "ratingRymValue",
    name: "RYM Rating",
    max: 5,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "ratingDiscogsVotes",
    name: "Discogs Votes",
    append: "",
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
    key: "ratingMetacriticVotes",
    name: "MC Votes",
    append: "",
    precision: 0,
  },
  {
    key: "ratingMetacriticValue",
    name: "MC Value",
    append: "%",
    precision: 1,
  },
  {
    key: "popularityDiscogs",
    name: "Discogs Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    key: "popularitySpotify",
    name: "Spotify Popularity",
    append: "%",
    precision: 1,
  },
  {
    key: "popularityLastFm",
    name: "Last.fm Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
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

export const textColumns = [
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
];

export function getColumnWithTotals<K extends keyof CleanAlbum>(
  rows: CleanAlbum[],
  colName: K,
  sort: "key" | "value" = "key"
): FilterValue[] {
  const total = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i][colName];
    const values =
      typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (let j = 0; j < values.length; j++) {
      total.set(values[j], (total.get(values[j]) ?? 0) + 1);
    }
  }

  let totalArray = Array.from(total).sort((a, b) =>
    (a[0] ?? "").localeCompare(b[0] ?? "")
  );

  if (sort === "value") {
    totalArray = totalArray.sort((a, b) => a[1] - b[1]);
  }

  return totalArray.map((r) => ({
    label: `${r[0]} (${r[1]})`,
    value: r[0],
    field: colName,
  }));
}

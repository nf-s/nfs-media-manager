import React from "react";
import { CleanAlbum } from "../../../movie-scraper/src/music/interfaces";
import {
  DefaultSort,
  DefaultVisible,
  FieldRenderer,
  FilterColKey,
  formatTime,
  GridCols,
  NumericCol,
  StringCol,
} from "./Columns";

export const Genres: FieldRenderer<CleanAlbum> = (props) => {
  return (
    <>
      {props.data.genres.map((g, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("genres", g)}
          key={`${props.data.id.spotify}-${g}`}
        >
          {g}
          {i < props.data.genres.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Artist: FieldRenderer<CleanAlbum> = (props) => (
  // eslint-disable-next-line jsx-a11y/anchor-is-valid
  <a onClick={() => props.addFilter("artist", props.data.artist)}>
    {props.data.artist}
  </a>
);

export const Release: FieldRenderer<CleanAlbum> = (props) => (
  <>
    <a
      href={`https://open.spotify.com/album/${props.data.id.spotify}`}
      title={props.data.title}
      target="blank"
    >
      {props.data.title}
    </a>
    {props.data.links.rym ? (
      <a
        href={props.data.links.rym}
        title={props.data.otherTitles.rym}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/sonemic.png" width="16px" alt="Sonemic link" />
      </a>
    ) : null}
    {props.data.links.discogs ? (
      <a
        href={props.data.links.discogs}
        title={props.data.otherTitles.discogs}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/discogs.png" width="16px" alt="Discogs link" />
      </a>
    ) : null}
    {props.data.links.mb ? (
      <a
        href={props.data.links.mb}
        title={props.data.otherTitles.mb}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/mb.png" width="16px" alt="MusicBrainz link" />
      </a>
    ) : null}

    {props.data.links.lastfm ? (
      <a
        href={props.data.links.lastfm}
        title={props.data.otherTitles.lastfm}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/lastfm.png" width="16px" alt="Lastfm link" />
      </a>
    ) : null}

    {props.data.links.mc ? (
      <a
        href={props.data.links.mc}
        title={props.data.otherTitles.mc}
        target="blank"
        className="row-external-links"
      >
        <img src="/img/metacritic.svg" width="16px" alt="Metacritic link" />
      </a>
    ) : null}
  </>
);

export const numericCols: NumericCol<CleanAlbum>[] = [
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
export const textColumns: StringCol<CleanAlbum>[] = [
  {
    key: "title",
    name: "Title",
    sortable: true,
    fieldRenderer: Release,
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
      <>{formatTime(props.data.durationSec)}</>
    )) as FieldRenderer<CleanAlbum>,
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

export const defaultSort: DefaultSort<CleanAlbum> = ["dateAdded", "DESC"];
export const defaultFilter: FilterColKey<CleanAlbum>[] = [
  "title",
  "artist",
  "genres",
];
export const defaultVisible: DefaultVisible<CleanAlbum> = [
  "Controls",
  "title",
  "artist",
  "durationSec",
  "dateReleased",
  "dateAdded",
  "genres",
  "ratingRymValue",
  "ratingRymVotes",
];

export const gridCols: GridCols<CleanAlbum> = {
  width: 250,
  height: 250,
  art: "art",
  cols: [textColumns[0], textColumns[1], textColumns[5]],
};

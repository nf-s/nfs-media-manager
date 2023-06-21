import React from "react";
import { CleanAlbum, SortValue, timeToDateString } from "data-types";
import { ArrayFilterRenderer } from "../Table/ColumnFilters.jsx";
import {
  DataColumn,
  DefaultVisible,
  FieldRenderer,
  formatTime,
  GridCols,
} from "../Table/Columns.jsx";

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

export const dataCols: DataColumn<CleanAlbum>[] = [
  {
    type: "string",
    key: "title",
    name: "Title",
    sortable: true,
    fieldRenderer: Release,
    enableFilter: true,
  },
  {
    type: "string",
    key: "artists",
    name: "Artists",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanAlbum>("artists", "spotifyId"),
    enableFilter: true,
  },
  {
    type: "string",
    key: "durationSec",
    name: "Duration",
    sortable: true,
    fieldRenderer: ((props) => (
      <>{formatTime(props.data.durationSec)}</>
    )) as FieldRenderer<CleanAlbum>,
    width: 80,
  },
  {
    type: "string",
    key: "genres",
    name: "Genres",
    fieldRenderer: ArrayFilterRenderer<CleanAlbum>("genres", "spotifyId"),
    enableFilter: true,
  },
  {
    type: "string",
    key: "countries",
    name: "Countries",
    fieldRenderer: ArrayFilterRenderer<CleanAlbum>("countries", "spotifyId"),
  },
  {
    type: "string",
    key: "playlists",
    name: "Playlists",
    fieldRenderer: ArrayFilterRenderer<CleanAlbum>("playlists", "spotifyId"),
    enableFilter: true,
    // filterLabel: (id) => library.playlists[id].name
  },
  {
    type: "numeric",
    key: "dateReleased",
    name: "Release",
    sortable: true,
    width: 150,
    numberFormat: timeToDateString,
  },
  {
    type: "numeric",
    key: "dateAdded",
    name: "Added",
    sortable: true,
    width: 150,
    numberFormat: timeToDateString,
  },
  {
    type: "numeric",
    key: "scrobbles",
    name: "Scrobbles",
    append: "",
    precision: 0,
    default: 0,
  },
  {
    type: "numeric",
    key: "ratingRymVotes",
    name: "RYM Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "ratingRymValue",
    name: "RYM Rating",
    max: 5,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    type: "numeric",
    key: "ratingDiscogsVotes",
    name: "Discogs Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "ratingDiscogsValue",
    name: "Discogs Rating",
    max: 5,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    type: "numeric",
    key: "ratingMetacriticVotes",
    name: "MC Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "ratingMetacriticValue",
    name: "MC Value",
    append: "%",
    precision: 1,
  },
  {
    type: "numeric",
    key: "popularityDiscogs",
    name: "Discogs Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    type: "numeric",
    key: "popularitySpotify",
    name: "Spotify Popularity",
    append: "%",
    precision: 1,
  },
  {
    type: "numeric",
    key: "popularityLastFm",
    name: "Last.fm Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
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
    name: "Instrumentalness",
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

export const defaultSort: SortValue<CleanAlbum> = ["dateAdded", "DESC"];

export const defaultVisible: DefaultVisible<CleanAlbum> = [
  "Controls",
  "title",
  "artists",
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
  cols: ["title", "artists", "dateReleased"],
};

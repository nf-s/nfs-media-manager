/* eslint-disable react-hooks/rules-of-hooks */
import { CleanAlbum, timeToDateString } from "data-types";
import React, { useContext } from "react";
import {
  SpotifyContext,
  SpotifyDispatchContext,
  queueAlbum,
} from "../Browser/Spotify/SpotifyContext.js";
import LinkIcon from "../Common/LinkIcon.js";
import { ColumnFieldRenderer, ColumnsConfig } from "../Table/Columns.js";
import {
  LinksColumn,
  LinksRenderer,
  formatTime,
} from "../Table/FieldRenderers.js";
import { ArrayFilterRenderer } from "../Table/FilterRenderers.js";

const AlbumLinkRenderer = LinksRenderer([
  { key: "rym", img: "/img/sonemic.png", alt: "Sonemic link" },
  { key: "discogs", img: "/img/discogs.png", alt: "Discogs link" },
  { key: "mb", img: "/img/mb.png", alt: "MusicBrainz link" },
  { key: "lastfm", img: "/img/lastfm.png", alt: "Lastfm link" },
  { key: "mc", img: "/img/metacritic.svg", alt: "Metacritic link" },
]);

const Release: ColumnFieldRenderer<CleanAlbum> = (props) => (
  <>
    <a
      href={`https://open.spotify.com/album/${props.data.id.spotify}`}
      title={props.data.title}
      target="blank"
    >
      {props.data.title}
      <LinkIcon size="xs" />
    </a>
  </>
);

const AlbumButtons: React.FC<{ row: CleanAlbum }> = (props) => {
  const spotifyContext = useContext(SpotifyContext);
  const spotifyDispatch = useContext(SpotifyDispatchContext);

  if (!spotifyContext?.api) return null;

  return (
    <div className="image-buttons">
      {
        <button
          onClick={(evt) => {
            queueAlbum(spotifyContext, props.row);
            evt.stopPropagation();
          }}
        >
          +
        </button>
      }
      {
        <button
          onClick={(evt) => {
            spotifyDispatch?.({
              type: "playAlbum",
              row: props.row,
            });
            evt.stopPropagation();
          }}
        >
          &#9654;
        </button>
      }
    </div>
  );
};

export const columnsConfig: ColumnsConfig<CleanAlbum> = {
  id: "spotifyId",
  data: [
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
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
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
      key: "genres",
      name: "Genres",
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "countries",
      name: "Countries",
      fieldRenderer: ArrayFilterRenderer,
    },
    {
      type: "string",
      key: "playlists",
      name: "Playlists",
      fieldRenderer: ArrayFilterRenderer,
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
      displayAsPercentOfMax: true,
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
      displayAsPercentOfMax: true,
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
  ],
  grid: {
    width: 220,
    height: 220,
    art: "art",
    cols: ["title", "artists", "dateReleased"],
    ButtonFC: AlbumButtons,
    links: AlbumLinkRenderer,
  },
  custom: [
    {
      key: "Controls",
      name: "",

      renderCell: (formatterProps: { row: CleanAlbum }) => {
        const spotifyContext = useContext(SpotifyContext);
        const spotifyDispatch = useContext(SpotifyDispatchContext);

        if (!spotifyContext?.api) return null;

        return (
          <>
            <button
              onClick={(evt) => {
                queueAlbum(spotifyContext, formatterProps.row);
                evt.stopPropagation();
              }}
            >
              +
            </button>
            <button
              onClick={(evt) => {
                spotifyDispatch?.({
                  type: "playAlbum",
                  row: formatterProps.row,
                });
                evt.stopPropagation();
              }}
            >
              &#9654;
            </button>
          </>
        );
      },
      width: 80,
      resizable: false,
    },
    LinksColumn(AlbumLinkRenderer),
  ],
  defaultVisible: [
    "Controls",
    "Links",
    "title",
    "artists",
    "durationSec",
    "dateReleased",
    "dateAdded",
    "genres",
    "ratingRymValue",
    "ratingRymVotes",
  ],
  defaultSort: ["dateAdded", "DESC"],
};

/* eslint-disable react-hooks/rules-of-hooks */
import { CleanAlbum, timeToDateString } from "data-types";
import React, { useContext } from "react";
import { ColumnFieldRenderer } from "../Browser/FieldRenderer.js";
import {
  SpotifyContext,
  SpotifyDispatchContext,
  queueAlbum,
} from "../Browser/SpotifyContext.js";
import { ArrayFilterRenderer } from "../Table/ColumnFilters.jsx";
import { ColumnsConfig } from "../Table/ColumnState.js";
import { formatTime } from "../Table/Columns.jsx";

const Release: ColumnFieldRenderer<CleanAlbum> = (props) => (
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

const AlbumButtons: React.FC<{ row: CleanAlbum }> = (props) => {
  const spotifyContext = useContext(SpotifyContext);
  const spotifyDispatch = useContext(SpotifyDispatchContext);

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
  ],
  grid: {
    width: 250,
    height: 250,
    art: "art",
    cols: ["title", "artists", "dateReleased"],
    ButtonFC: AlbumButtons,
  },
  custom: [
    {
      key: "Controls",
      name: "",
      renderCell: (formatterProps: { row: CleanAlbum }) => {
        const spotifyContext = useContext(SpotifyContext);
        const spotifyDispatch = useContext(SpotifyDispatchContext);
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
  ],
  defaultVisible: [
    "Controls",
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

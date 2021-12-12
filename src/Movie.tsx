import axios from "axios";
import React, { useEffect, useState } from "react";
import { CleanMovie } from "../../movie-scraper/src/movie/interfaces";
import Browser from "./Browser";
import * as Movie from "./Table/Movie";

export default function M(props: { darkMode: boolean }) {
  const [playlistData, setPlaylistData] = useState<{
    rows: CleanMovie[];
  }>({ rows: [] });

  useEffect(() => {
    const fetchData = async () => {
      const library = await axios("/lib-movie.json");

      const movies = library.data as CleanMovie[];

      setPlaylistData({
        rows: movies,
      });
    };

    fetchData();
  }, []);

  return (
    <div className="root-music">
      <Browser
        idCol={"id"}
        tag={"movie"}
        rows={playlistData.rows}
        filterCols={Movie.defaultFilter}
        defaultSort={Movie.defaultSort}
        defaultVisible={Movie.defaultVisible}
        numericCols={Movie.numericCols}
        textColumns={Movie.textColumns}
        booleanColumns={Movie.booleanCols}
        gridColumns={Movie.gridCols}
      />
    </div>
  );
}

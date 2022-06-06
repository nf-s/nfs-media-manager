import axios from "axios";
import React, { useEffect, useState } from "react";
import { CleanMovie } from "../../movie-scraper/src/movie/interfaces";
import Browser from "./Browser";
import * as Movie from "./Table/Movie";

export default function M(props: { darkMode: boolean }) {
  const [movieData, setMovieData] = useState<{
    rows: CleanMovie[];
  }>({ rows: [] });

  useEffect(() => {
    const fetchData = async () => {
      const library = await axios("/lib-movie.json");

      const movies = library.data as CleanMovie[];

      setMovieData({
        rows: movies,
      });
    };

    fetchData();
  }, []);

  return (
    <div className="root-music">
      <Browser
        tag={"movie"}
        rows={movieData.rows}
        defaultSort={Movie.defaultSort}
        defaultVisible={Movie.defaultVisible}
        dataColumns={Movie.dataColumns}
        gridColumns={Movie.gridCols}
        customColumns={[]}
      />
    </div>
  );
}

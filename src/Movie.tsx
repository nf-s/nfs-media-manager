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
        filterCols={["directors", "tags", "collections"]}
        defaultSort={["releaseDate", "DESC"]}
        defaultVisible={[
          "Controls",
          "title",
          "directors",
          "releaseDate",
          "tags",
        ]}
        numericCols={Movie.numericCols}
        textColumns={Movie.textColumns}
        gridColumns={{
          art: "poster",
          width: 150,
          height: 220,
          cols: [
            Movie.textColumns[0],
            Movie.textColumns[1],
            Movie.textColumns[2],
          ],
        }}
      />
    </div>
  );
}

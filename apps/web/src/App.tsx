import React, { useState } from "react";
import Movie from "./Browser/Movie.jsx";

// import Movie from "./Movie";
import Music from "./Browser/Music.jsx";

function App() {
  // const [spotifyAuthToken, setSpotifyAuthToken] = useState<string>();
  const spotifyAuthToken = undefined;

  const [mode, setMode] = useState<{ mode: "movie" | "music" | "playlist" }>({
    mode: "music",
  });
  const [darkMode, setDarkMode] = useState<boolean>(false);

  return (
    <div id="root" className={darkMode ? "dark" : ""}>
      <div className={"toolbar"}>
        <button type="button" onClick={() => setMode({ mode: "movie" })}>
          Movies
        </button>
        <button type="button" onClick={() => setMode({ mode: "music" })}>
          Music
        </button>
        <button type="button" onClick={() => setMode({ mode: "playlist" })}>
          Playlist
        </button>
        <button type="button" onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? "Light" : "Dark"}
        </button>
      </div>

      {mode.mode === "movie" ? <Movie></Movie> : null}
      {mode.mode === "music" && spotifyAuthToken ? (
        <Music
          spotifyToken={spotifyAuthToken}
          darkMode={darkMode}
          mode={"albums"}
        ></Music>
      ) : null}
      {mode.mode === "playlist" && spotifyAuthToken ? (
        <Music
          spotifyToken={spotifyAuthToken}
          darkMode={darkMode}
          mode={"playlist"}
        ></Music>
      ) : null}
      {!spotifyAuthToken ? <h2>Fetching Spotify token</h2> : null}
    </div>
  );
}

export default App;

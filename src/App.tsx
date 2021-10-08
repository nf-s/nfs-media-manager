import React, { useEffect, useState } from "react";
import Movie from "./Movie";

// import Movie from "./Movie";
import Music from "./Music";
import { SpotifyAuth } from "./Spotify";

function App() {
  const [spotifyAuthToken, setSpotifyAuthToken] = useState<string>();

  useEffect(() => {
    const spotifyAuth = new SpotifyAuth(setSpotifyAuthToken);
    spotifyAuth.init();
  }, []);

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
          Music
        </button>
        <button type="button" onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? "Light" : "Dark"}
        </button>
      </div>

      {mode.mode === "movie" ? <Movie darkMode={darkMode}></Movie> : null}
      {mode.mode === "music" && spotifyAuthToken ? (
        <Music spotifyToken={spotifyAuthToken} darkMode={darkMode}></Music>
      ) : null}
      {mode.mode === "playlist" && spotifyAuthToken ? (
        <Music spotifyToken={spotifyAuthToken} darkMode={darkMode}></Music>
      ) : null}
      {!spotifyAuthToken ? <h2>Fetching Spotify token</h2> : null}
    </div>
  );
}

export default App;

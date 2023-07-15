import React, { useContext } from "react";
import SpotifyPlayerWeb from "react-spotify-web-playback";
import { SpotifyContext, SpotifyDispatchContext } from "./SpotifyContext.js";

function SpotifyPlayer() {
  const spotifyContext = useContext(SpotifyContext);
  const spotifyDispatch = useContext(SpotifyDispatchContext);

  return (
    <div className={"player"}>
      {spotifyContext?.authToken ? (
        <SpotifyPlayerWeb
          name="Nick's Web Player"
          showSaveIcon={true}
          token={spotifyContext.authToken}
          callback={(state: any) => {
            if (!spotifyDispatch || !spotifyContext?.api) return;

            if (state.deviceId)
              spotifyDispatch({
                type: "update",
                value: { deviceId: state.deviceId },
              });
            if (state.isPlaying)
              spotifyDispatch({
                type: "update",
                value: { waitForPlay: false },
              });
            if (!state.isPlaying && spotifyContext.waitForPlay) return;

            if (!spotifyContext?.queuePlaylist || state.type !== "track_update")
              return;

            if (!state.isPlaying && state.nextTracks.length === 0) {
              // Hacky way to get my playlist queue to start if there aren't any tracks to play
              spotifyDispatch({
                type: "update",
                value: { uris: [], play: false, waitForPlay: true },
              });
              setTimeout(() => {
                spotifyDispatch({
                  type: "update",
                  value: {
                    uris: [`spotify:playlist:${spotifyContext!.queuePlaylist}`],
                    play: true,
                    waitForPlay: true,
                  },
                });
              }, 500);
            } else if (
              state.isPlaying &&
              spotifyContext?.uris?.[0] ===
                `spotify:playlist:${spotifyContext!.queuePlaylist}`
            ) {
              spotifyContext.api
                .getMyCurrentPlaybackState()
                .then((playbackState) => {
                  if (
                    spotifyContext.queuePlaylist &&
                    playbackState.context?.uri ===
                      `spotify:playlist:${spotifyContext.queuePlaylist}`
                  ) {
                    spotifyContext.api!.removeTracksFromPlaylist(
                      spotifyContext.queuePlaylist,
                      [state.track.uri]
                    );
                  }
                });
            }
          }}
          play={spotifyContext?.play}
          uris={spotifyContext?.uris}
          styles={{
            activeColor: "#00c583",
            bgColor: "#333",
            color: "#fff",
            loaderColor: "#fff",
            sliderColor: "#00c583",
            sliderHandleColor: "#dbfff8",
            trackArtistColor: "#ccc",
            trackNameColor: "#fff",
          }}
        />
      ) : (
        <button
          type="button"
          className="player-login-button"
          onClick={() =>
            spotifyDispatch?.({ type: "update", value: { enabled: true } })
          }
        >
          Log into Spotify
        </button>
      )}
    </div>
  );
}

export default SpotifyPlayer;

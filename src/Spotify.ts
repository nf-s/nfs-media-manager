import axios from "axios";
import SpotifyWebApi from "spotify-web-api-js";
import config from "./config.json";

export class SpotifyAuth {
  static scopeString = [
    "playlist-modify-public",
    "playlist-modify-private",
    "playlist-read-private",
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-library-read",
    "user-library-modify",
    "user-read-playback-state",
    "user-modify-playback-state",
  ].join("%20");
  static redirectUrl = `http://${window.location.host}/callback`;

  private clientId: string;
  private clientSecret: string;

  private refreshToken: string | undefined;
  private _token: string | undefined;

  private _refreshTimer: NodeJS.Timer | undefined;

  constructor(private _onTokenUpdate: (t: string) => unknown) {
    if (!config.spotifyCreds.clientId)
      throw new Error(
        `Spotify clientId is undefined - please set spotifyCreds.clientId in config.json`
      );
    this.clientId = config.spotifyCreds.clientId;
    if (!config.spotifyCreds.clientId)
      throw new Error(
        `Spotify clientSecret is undefined - please set spotifyCreds.clientSecret in config.json`
      );
    this.clientSecret = config.spotifyCreds.clientSecret;
  }

  async init() {
    const urlParams = new URLSearchParams(window.location.search);

    const spotifyCode = urlParams.get("code");
    if (spotifyCode) {
      this.fetchToken(spotifyCode);
      window.history.pushState("", "", "/");
    } else {
      if (!this.token) {
        this.redirect();
      } else {
        this._onTokenUpdate(this.token);
      }
    }
  }

  get token() {
    return this._token;
  }

  set token(t: string | undefined) {
    if (this._token !== t) {
      this._token = t;
      console.log(`UPDATING SPOTIFY TOKEN`);
      if (t) this._onTokenUpdate(t);
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        if (this.refreshToken) {
          console.log(`REFRESHING SPOTIFY TOKEN`);
          this.fetchToken(this.refreshToken, "refresh_token");
        }
      }, 50 * 60 * 1000); // update every 50 mins
    }
  }

  private get clientAuth() {
    return new Buffer(`${this.clientId}:${this.clientSecret}`).toString(
      "base64"
    );
  }

  redirect() {
    window.location.href = `https://accounts.spotify.com/authorize?client_id=${this.clientId}&response_type=code&redirect_uri=${SpotifyAuth.redirectUrl}&scope=${SpotifyAuth.scopeString}`;
  }

  async fetchToken(
    code: string,
    type: "authorization_code" | "refresh_token" = "authorization_code"
  ) {
    try {
      const params = new URLSearchParams();
      params.append("grant_type", type);
      if (type === "authorization_code") {
        params.append("code", code);
        params.append("redirect_uri", SpotifyAuth.redirectUrl);
      } else {
        params.append("refresh_token", code);
      }

      const response = await axios.post(
        "https://accounts.spotify.com/api/token",
        params,
        {
          headers: {
            Authorization: `Basic ${this.clientAuth}`,
          },
        }
      );

      if (type === "authorization_code") {
        this.refreshToken = response.data.refresh_token;
      }

      this.token = response.data.access_token;
    } catch (error) {
      console.log(error);
      throw new Error("Failed to fetch token from spotify");
    }
  }
}

export const PLAYLIST_NAME = "_nick-web-player-queue";

export async function getQueuePlaylistId(
  spotifyApi: SpotifyWebApi.SpotifyWebApiJs,
  userId: string
) {
  let playlistId = await new Promise<string | undefined>((resolve, reject) => {
    const getAlbums = async (offset = 0, limit = 50) => {
      console.log(`fetching spotify playlists offset=${offset}`);
      try {
        const response = await spotifyApi.getUserPlaylists(userId, {
          limit,
          offset,
        });
        const queuePlaylist = response.items.find(
          (playlist) => playlist.name === PLAYLIST_NAME
        );
        if (queuePlaylist) {
          resolve(queuePlaylist.id);
          console.log(`FOUND PLAYLIST!`);
          return;
        }
        const nextOffset = response.next
          ?.match(/offset=([0-9]+)/g)?.[0]
          ?.split("=")?.[1];
        if (nextOffset) {
          getAlbums(parseInt(nextOffset));
        } else {
          console.log(`FINISHED fetching spotify playlists`);
          resolve(undefined);
        }
      } catch (error) {
        console.log(`FAILED to fetched spotify playlists offset=${offset}`);
        console.log(error);
        reject();
      }
    };

    getAlbums();
  });

  if (playlistId === undefined) {
    const playlist = await spotifyApi.createPlaylist(userId, {
      name: PLAYLIST_NAME,
      public: false,
      description:
        "This playlist was created by Nick's Spotify Web Player because Spotify Web API is garbage.",
    });

    playlistId = playlist.id;
  }

  return playlistId;
}

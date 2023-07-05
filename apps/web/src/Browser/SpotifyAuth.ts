function generateRandomString(length: number) {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier: string) {
  function base64encode(string: ArrayBuffer) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(string) as any))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", data);

  return base64encode(digest);
}

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
  ].join(" ");

  static redirectUrl = `http://${window.location.host}/callback`;

  private clientId: string | undefined;

  private refreshToken: string | undefined;
  private _token: string | undefined;

  private _refreshTimer: NodeJS.Timer | undefined;

  constructor(private _onTokenUpdate: (t: string) => unknown) {}

  async init() {
    const config = await (await fetch("/config.json")).json();

    if (typeof config.spotifyClientId !== "string") {
      throw new Error(
        "Spotify clientId is undefined - please set spotifyClientId in config.json"
      );
    }

    this.clientId = config.spotifyClientId;

    const urlParams = new URLSearchParams(window.location.search);

    const spotifyCode = urlParams.get("code");

    if (spotifyCode) {
      this.fetchToken(spotifyCode);
      // window.history.pushState("", "", "/");
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

  async redirect() {
    if (typeof this.clientId !== "string") {
      throw new Error(
        "Spotify clientId is undefined - please set spotifyClientId in config.json"
      );
    }

    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const state = generateRandomString(16);

    localStorage.setItem("code_verifier", codeVerifier);

    const args = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      scope: SpotifyAuth.scopeString,
      redirect_uri: SpotifyAuth.redirectUrl,
      state: state,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });

    window.location.href = "https://accounts.spotify.com/authorize?" + args;
  }

  async fetchToken(
    code: string,
    type: "authorization_code" | "refresh_token" = "authorization_code"
  ) {
    if (typeof this.clientId !== "string") {
      throw new Error(
        "Spotify clientId is undefined - please set spotifyClientId in config.json"
      );
    }

    console.log(`Fetching token from spotify: ${type}`);

    try {
      const params = new URLSearchParams();
      params.append("grant_type", type);
      if (type === "authorization_code") {
        params.append("code", code);
        params.append("redirect_uri", SpotifyAuth.redirectUrl);
      } else {
        params.append("refresh_token", code);
      }

      const codeVerifier = localStorage.getItem("code_verifier");

      if (typeof codeVerifier !== "string") {
        throw new Error("code_verifier not found in localStorage");
      }

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: SpotifyAuth.redirectUrl,
        client_id: this.clientId,
        code_verifier: codeVerifier,
      });

      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body,
      });

      const data = await response.json();

      if (type === "authorization_code" && data.access_token) {
        this.refreshToken = data.refresh_token;
        this.token = data.access_token;
      } else {
        throw new Error("Failed to fetch token from spotify");
      }
    } catch (error) {
      console.log(error);
      throw new Error("Failed to fetch token from spotify");
    }
  }
}

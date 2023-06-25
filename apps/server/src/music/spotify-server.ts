import debugPkg from "debug";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import open from "open";
import { stringify } from "querystring";

dotenv.config();

const debug = debugPkg.debug("music-scraper:server");

const PORT = process.env.SERVER_PORT;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_CLIENT_REDIRECT_URI;

if (!PORT) {
  throw new Error("Set SERVER_PORT in .env");
}

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  throw new Error(
    "Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_CLIENT_REDIRECT_URI in .env"
  );
}

const STATE = generateRandomString(16);

export async function getSpotifyToken() {
  const app = express();

  let resolveToken: (value: string) => void;
  let rejectToken: (reason?: any) => void;

  const spotifyTokenPromise: Promise<string> = new Promise(
    (resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    }
  );

  app.get("/login", function (req, res) {
    const scope =
      "playlist-modify-public playlist-read-private playlist-modify-private playlist-read-collaborative playlist-read-collaborative user-library-read streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-library-read user-library-modify";

    res.redirect(
      "https://accounts.spotify.com/authorize?" +
        stringify({
          response_type: "code",
          client_id: CLIENT_ID,
          scope: scope,
          redirect_uri: REDIRECT_URI,
          state: STATE,
        })
    );
  });

  app.get("/callback", async function (req, res) {
    const code = req.query.code || null;
    const state = req.query.state || null;

    if (state !== STATE) {
      res.redirect(
        "/#" +
          stringify({
            error: "state_mismatch",
          })
      );
    } else {
      try {
        const authResponse = await fetch(
          "https://accounts.spotify.com/api/token",
          {
            method: "POST",
            body: stringify({
              code: code?.toString(),
              redirect_uri: REDIRECT_URI,
              grant_type: "authorization_code",
            }),
            headers: {
              Authorization:
                "Basic " +
                Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );

        const authJson = await authResponse.json();

        if (
          typeof authJson === "object" &&
          authJson !== null &&
          "access_token" in authJson &&
          typeof authJson.access_token === "string" &&
          authJson.access_token.length > 0
        ) {
          resolveToken(authJson.access_token);
          res.send(
            '<html><head><title></title><script type="text/javascript">window.close();</script></html>'
          );
        } else {
          rejectToken("Invalid response");
        }
      } catch (e) {
        rejectToken(e);
        res.status(403).send("Error");
      }
    }
  });

  app.listen(process.env.SERVER_PORT);

  // Open browser
  open(`http://localhost:${PORT}/login`);

  debug("Server listening on port %s", PORT);

  return await spotifyTokenPromise;
}

function generateRandomString(length: number) {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < length; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}

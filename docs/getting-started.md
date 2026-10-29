# Getting started

This guide runs the app on your computer with the web interface at `http://localhost:3000`, the API at `http://localhost:4000` and PostgreSQL at `localhost:5431`.

## 1. Install the prerequisites

- [Node.js 22](https://nodejs.org/en/download) and Corepack. The repository pins pnpm 9.12; the commands below use `corepack pnpm` so you do not need a separate global pnpm installation.
- [Docker with Compose](https://docs.docker.com/get-started/get-docker/) for the supplied local database, or your own PostgreSQL 17 server.
- Git, and a current browser.

If your Node installation does not include Corepack, follow the [pnpm installation guide](https://pnpm.io/installation). Run all commands from the repository root unless shown otherwise.

```sh
git clone https://github.com/nf-s/nfs-media-manager.git
cd nfs-media-manager
corepack pnpm install --frozen-lockfile
```

## 2. Configure the app

For a new installation:

```sh
cp .env.example.local .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the first random value in `BETTER_AUTH_SECRET` and the second in `MEDIA_ENCRYPTION_KEY`. Set your initial account email, name and password. Use a password of at least eight characters. Keep this file private.

The apps and server commands load the root `.env` automatically. A root `.env.local`, if present, overrides it. You do not need shell exports or a browser configuration file. Do not copy the example over an existing installation's environment.

### Required settings

The example supplies the local defaults below. Change the account details and both secrets before starting.

| Variable                                   | Local default / purpose                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                  | `http://localhost:3000` — browser web origin.                                                                                                                               |
| `WEB_PORT`                                 | `3000` — port used by the web development launcher.                                                                                                                         |
| `PORT`                                     | `4000` — API port.                                                                                                                                                          |
| `AUTH_BASE_URL`                            | `http://localhost:4000` — browser-facing API/auth origin.                                                                                                                   |
| `INTERNAL_BACKEND_URL`                     | `http://localhost:4000` — API address reachable by the web server. With the development switch below, it must also be reachable by your browser.                            |
| `INTERNAL_FRONTEND_URL`                    | `http://localhost:3000` — internal web address.                                                                                                                             |
| `TRUSTED_ORIGINS`                          | `http://localhost:3000,http://localhost:4000` — comma-separated allowed web/API origins, without spaces.                                                                    |
| `DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND` | `true` — the browser calls the separate local API port.                                                                                                                     |
| `DATABASE_HOST` / `DATABASE_PORT`          | `localhost` / `5431`.                                                                                                                                                       |
| `DATABASE_USER` / `DATABASE_PASSWORD`      | `admin` / `admin` for the supplied local development database.                                                                                                              |
| `DATABASE_NAME`                            | `media-manager-dev`.                                                                                                                                                        |
| `DATABASE_SSL`                             | `disable` for the local Docker database; use `verify` for hosted TLS connections. If omitted, production defaults to certificate verification and development disables TLS. |
| `BETTER_AUTH_SECRET`                       | Your random secret, at least 32 characters. Signs authentication data.                                                                                                      |
| `MEDIA_ENCRYPTION_KEY`                     | A separate random secret, at least 32 characters. Encrypts saved provider credentials and account tokens. Keep it with your database backup.                                |
| `INITIAL_USER_EMAIL`                       | Your sign-in email.                                                                                                                                                         |
| `INITIAL_USER_NAME`                        | Your display name.                                                                                                                                                          |
| `INITIAL_USER_PASSWORD`                    | Your initial sign-in password, at least eight characters.                                                                                                                   |

`DATABASE_URL` may replace the five database connection fields. Runtime, migration and seed commands use the same connection settings. For private certificate authorities, provide the trusted CA through Node's `NODE_EXTRA_CA_CERTS`; do not disable certificate verification. `DATABASE_SCHEMA` is optional schema configuration; leave it unset for the standard installation.

### Optional settings

| Variable                 | Purpose                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `SCAN_DIR`               | Absolute server-side folder to scan for film NFO files. Leave empty if you only import CSVs.                                    |
| `SCAN_EXCLUDE`           | Comma-separated folder names to skip during NFO scans.                                                                          |
| `MEDIA_PLUGIN_PATHS`     | Comma-separated local provider entry-file paths. Leave empty for the built-in providers. See [local plugins](local-plugins.md). |
| `LEGACY_SERVER_DATA_DIR` | Legacy raw JSON directory; defaults to `apps/server/data`.                                                                      |
| `LEGACY_WEB_DIST_DIR`    | Legacy cleaned-data fallback directory; defaults to `apps/web/dist`.                                                            |
| Provider variables       | Optional alternatives to saving credentials in Providers; see the table below.                                                  |

## 3. Start PostgreSQL

```sh
docker compose -f docker-compose-dev.yml up -d db
docker compose -f docker-compose-dev.yml exec db pg_isready -U admin -d media-manager-dev
```

Wait until PostgreSQL reports that it is accepting connections. The supplied container is for local development and listens on the loopback interface. If you use another PostgreSQL instance, create an empty database and adjust the connection settings first.

If port 5431 is occupied, use your existing database or change the Compose host port and `DATABASE_PORT` together. Do not remove a running database or its volume to free the port. The development container uses PostgreSQL's attached data volume: use `docker compose -f docker-compose-dev.yml stop` when you want to pause it. Removing/recreating the container can detach that volume; back up before doing so.

## 4. Create the tables and your account

```sh
corepack pnpm --filter @repo/schemas build
corepack pnpm --filter @repo/media-plugin-sdk build
corepack pnpm --filter @repo/server migrate
corepack pnpm --filter @repo/server seed
```

Seeding creates the initial administrator from the three `INITIAL_USER_*` settings. It skips an account that already exists; editing the environment and rerunning seed does not reset that account's password. Public sign-up is disabled.

## 5. Start the app

```sh
corepack pnpm dev
```

Open [localhost:3000](http://localhost:3000) and sign in. Keep this terminal running. Stop the app with Ctrl+C.

An empty library is expected. Choose Films or Albums in the top-left selector, then open **Imports**. File imports do not require any API keys. Provider enrichment is optional and must be selected explicitly.

## 6. Add the providers you want

Open **Providers**, choose a service and select **Credentials**. Save its required fields. Saved values are encrypted in the database and take precedence over environment variables. Existing secret values are not displayed; leaving a field blank keeps its saved value.

| Provider    | What to configure                                   | Where to get access                                                                                                                           | Optional environment variables                |
| ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| TMDb        | API key (v3 key, not the read-access token)         | [TMDb account API settings](https://www.themoviedb.org/settings/api) and [setup guide](https://developer.themoviedb.org/docs/getting-started) | `TMDB_API_KEY`                                |
| OMDb        | API key                                             | [Request an OMDb key](https://www.omdbapi.com/apikey.aspx)                                                                                    | `OMDB_API_KEY`                                |
| MDBList     | API key                                             | [MDBList Preferences](https://mdblist.com/preferences/)                                                                                       | `MDBLIST_API_KEY`                             |
| Spotify     | Client ID and client secret                         | [Spotify developer dashboard](https://developer.spotify.com/dashboard)                                                                        | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`  |
| MusicBrainz | App name, app version and contact email; no API key | [MusicBrainz API identification requirements](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)                                      | `MB_APP_NAME`, `MB_APP_VERSION`, `MB_CONTACT` |
| Last.fm     | API key; optional username for personal scrobbles   | [Create a Last.fm API account](https://www.last.fm/api/account/create)                                                                        | `LASTFM_API_KEY`, `LASTFM_USERNAME`           |
| Discogs     | Personal access token                               | [Discogs developer settings](https://www.discogs.com/settings/developers)                                                                     | `DISCOGS_TOKEN`                               |
| Serply      | API key for Rate Your Music search metadata         | [Serply dashboard](https://app.serply.io/)                                                                                                    | `SERPLY_API_KEY`                              |

Where supported, **Check credentials** makes a small real request. Saving credentials alone does not scrape your collection. Providers without a credential-check endpoint are checked when you explicitly run a lookup. **Settings** shows limits and configurable budgets; **Activity** shows requests and cooldowns. A higher app budget cannot increase a service's account quota.

### Spotify saved albums

Album metadata needs only the client ID and secret. To import your saved albums, also register this exact redirect URI in the Spotify developer dashboard:

```text
http://127.0.0.1:4000/api/v1/spotify/callback
```

Save the same URL as Spotify's **OAuth redirect URI**, or set `SPOTIFY_CLIENT_REDIRECT_URI`. Keep the app and auth addresses on `localhost`; the callback uses `127.0.0.1` because Spotify rejects `localhost` callbacks. If your API port is different, change the callback port too. See [Spotify's redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

Open **Imports → Spotify**, connect your account and approve read-only saved-album access. Preview a small batch first. A full-library read requires explicit confirmation. The [Spotify guide](spotify-album-imports.md) explains the exact authorization flow and preview limits.

## Your first import and metadata refresh

1. Choose a library, then **Imports** and the matching file format.
2. Drop your CSV, or preview new NFO films from the configured folder.
3. Review the rows. For a local-only import, leave metadata providers unselected.
4. Import the selected rows, then return to Browse.
5. To enrich existing items, open **Jobs → Metadata**, select a few items and providers, review the total and confirm.

Film CSVs accept IMDb ratings/watchlist exports. Album CSVs need `title,artist`; UPC CSVs additionally need `upc`. See [import formats](importing.md) for examples, identity matching and existing-library migration.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database connection refused                   | Start PostgreSQL; run `pg_isready`; match host/port/name to your environment.                                                                                                  |
| Tables or relations missing                   | Run migrations against the same database used by the API.                                                                                                                      |
| Package exports or shared types missing       | Run the schemas and plugin SDK build commands above, then restart development.                                                                                                 |
| Sign-in fails or immediately returns to login | Verify the seeded email/password and that web/API hosts, ports and trusted origins agree. Avoid mixing `localhost` and `127.0.0.1` except for the documented Spotify callback. |
| Configuration changes have no effect          | Check `.env.local`, which overrides `.env`, then restart the app.                                                                                                              |
| Provider reports missing credentials          | Set its required fields in Providers or use the documented environment variables. Select the correct film/album library.                                                       |
| A film needs an ID                            | Open its detail page, choose Edit and add/correct IMDb or TMDb identifiers.                                                                                                    |
| Jobs pause or fail                            | Read the stored error and provider cooldown. Fix the credential/identifier issue before reviewing a retry. No automatic retries are made.                                      |
| Spotify redirect mismatch                     | Register the exact API callback URL, including port and path, in both places.                                                                                                  |
| No NFO files found                            | `SCAN_DIR` must exist on the API server; symlinks, hidden/recycle folders and `SCAN_EXCLUDE` entries are skipped.                                                              |

## Upgrading and backing up

Keep a database backup and a secure copy of `.env`, `.env.local` and any local plugins. The encryption key is needed to read saved credentials after restoring a database.

For the supplied local PostgreSQL container:

```sh
mkdir -p backups
docker compose -f docker-compose-dev.yml exec -T db pg_dump -U admin -d media-manager-dev -Fc > backups/media-manager.dump
```

Stop the app before upgrading, install the lockfile's dependencies, rebuild the schemas and plugin SDK, run migrations, and restart. Keep the same database and encryption key. Do not run seed to reset an existing account or remove volumes as an upgrade step. Backups are ignored by Git.

## Hosting beyond your computer

The quick start is a development setup. For an HTTPS deployment, build the web app, run the API and web processes separately, and proxy `/api/*` to Hono on the same public origin. Set `APP_URL`, `AUTH_BASE_URL` and `TRUSTED_ORIGINS` to that origin; set `DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND=false`; keep `INTERNAL_BACKEND_URL` reachable from the web server. Production auth uses secure cookies, so HTTP sign-in will not work.

Run one API worker process per database. Use a durable PostgreSQL service with verified TLS, private database networking and regular backups. Migrate before starting the API. Provider secrets, OAuth callback query strings and local plugins must remain out of public logs and source control. There is no supported container image or one-click production deployment in this release.

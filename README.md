# NFS Media Manager

Early stages of development

Media scraper and Media browser (simple web UI)

## Setup

```bash
# Install pnpm
npm i -g pnpm

# Install turbo
pnpm add turbo --global

# Install dependencies
pnpm i

# Build
turbo run build
```

## Media-scraper

- Scrape film metadata from TMDB and OMDB using Kodi/XBMC NFO files
- Scrape albums from Spotify, Discogs, MusicBrainz and CSV

Rename `apps/server/sample.env` -> `apps/server/.env` and set values

Run

```bash
cd apps/server

# Scrape albums
pnpm run start music

# Scrape movies
pnpm run start movie
```

## Media-browser

### Spotify Album Player

Run

```bash
cd apps/web

pnpm run dev
```

#### Grid mode

![image](https://user-images.githubusercontent.com/6187649/109418482-b5a38e80-7a1c-11eb-8758-50882f3a6e3b.png)

#### Table mode

![image](https://user-images.githubusercontent.com/6187649/109418445-89880d80-7a1c-11eb-9ed6-c52bc61c88f9.png)

### Movie browser

#### Grid mode

![image](https://user-images.githubusercontent.com/6187649/136588887-4b6de045-78cb-46c9-8c8e-ec3c7285a493.png)

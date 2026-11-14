# Documentation

Start with [getting started](getting-started.md) for installation or [application architecture](handoff.md) for the data model. Coding agents should also read [AGENTS.md](../AGENTS.md).

## Using the app

- [Getting started](getting-started.md): installation, account setup, environment variables, provider API keys and troubleshooting.
- [Importing a library](importing.md): CSV, NFO, Spotify and legacy JSON workflows.
- [Spotify account setup](spotify-album-imports.md): callbacks, saved-album previews and read-only access.
- [Tracks and Spotify playlists](tracks-and-playlists.md): importing playlists, Liked Songs and stored Last.fm tracks, source filters, album links and playback matching.
- [Film collections](film-collections.md): browsing stored collections and their ordered film memberships.
- [Spotify playback](spotify-playback.md): optional in-app player, queue, devices and what the browser sends to Spotify.
- [Last.fm scrobble history](lastfm-scrobbles.md): syncing scrobbles, album linking, listening charts and browse fields.
- [Subscriptions](subscriptions.md): YouTube channels and Spotify podcasts in one library: setup, sync, search, filters and API.
- [AI search and voice input](ai-search.md): natural-language filters, voice search and Cloudflare configuration.
- [Local provider plugins](local-plugins.md): optional integrations outside this repository.
- [Album provider behavior](album-providers.md) and [film providers](film-keyword-providers.md): supported metadata and lookup limits.

## Maintaining an existing installation

Back up the database and encryption key before migrations or repair commands.

- [Upgrades and backups](getting-started.md#upgrading-and-backing-up)
- [Recovering film Added dates](nfo-creation-dates.md)
- [Tag provenance repair](tag-provenance-backfill.md)
- [Historical job repair](job-history-split.md)
- [Retired Google search data](google-search-retirement.md)
- [Retired Spotify audio features](spotify-audio-feature-removal.md)

## Development

- [Development commands and checks](development.md)
- [UI guidelines](dev-guidelines-ui.md) and [backend guidelines](dev-guidelines-backend.md)
- [Secondary tables](secondary-tables.md): shared sorting, column controls, styling and verification.
- [Job worker](job-worker.md)
- [Feature requirements](requirements/README.md) and [verification checklist](requirements/verification.md)

Keep installation-specific Markdown in ignored `docs/.local/`. Use only synthetic examples and screenshots in public documentation.

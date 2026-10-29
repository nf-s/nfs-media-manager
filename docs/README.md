# Documentation

## Using the app

- [Getting started](getting-started.md): installation, account setup, environment variables, provider API keys and troubleshooting.
- [Importing a library](importing.md): CSV, NFO, Spotify and legacy JSON workflows.
- [Spotify account setup](spotify-album-imports.md): callbacks, saved-album previews and read-only access.
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
- [Job worker](job-worker.md)
- [Feature requirements](requirements/README.md) and [verification history](requirements/verification.md)

The requirements and verification history describe development decisions and past checks. Start with Getting started for the current installation steps.

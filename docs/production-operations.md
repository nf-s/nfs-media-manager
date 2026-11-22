# Production operations

For the Node server, follow the [self-hosting guide](getting-started.md#hosting-beyond-your-computer) and [job worker lifecycle](job-worker.md). Deployment-specific addresses, account settings, release records and operator notes do not belong in the public repository.

## Cloudflare Workers releases

Each push to `main` can deploy from GitHub-hosted Actions after Checks and both PostgreSQL query performance jobs pass for the same commit. Configure a GitHub environment named `production` and restrict deployments to `main`. Keep the following values in that environment's secrets.

| Secret                                               | Value                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_ONE_REPOSITORY`, `PROVIDER_TWO_REPOSITORY` | Two different private GitHub repositories in `owner/repository` form.                                                                                                   |
| `PROVIDER_ONE_REVISION`, `PROVIDER_TWO_REVISION`     | Full 40-character commit SHA for each provider. Keep each commit reachable in its repository.                                                                           |
| `PROVIDER_ONE_ENTRYPOINT`, `PROVIDER_TWO_ENTRYPOINT` | Files relative to their respective checkouts, for example `providers/fixture/index.ts`. Use paths without spaces, and commit every source file the entrypoints require. |
| `PROVIDER_ONE_DEPLOY_KEY`, `PROVIDER_TWO_DEPLOY_KEY` | Private halves of two separate GitHub SSH deploy keys. Register each key with read-only access to its corresponding provider repository.                                |
| `CLOUDFLARE_ACCOUNT_ID`                              | Account containing the two production Workers.                                                                                                                          |
| `CLOUDFLARE_APP_URL`                                 | Canonical HTTPS application origin.                                                                                                                                     |
| `CLOUDFLARE_API_TOKEN`                               | Dedicated, account-scoped deployment token with Workers Scripts and Queues edit permissions.                                                                            |
| `MIGRATION_CHECK_DATABASE_URL` (optional)            | Connection URL for a production database role that can only read `drizzle.__drizzle_migrations` (`USAGE` on schema `drizzle`, `SELECT` on that table).                  |
| `BROWSE_CHECK_SESSION_TOKEN` (optional)              | Value of the `__Secure-better-auth.session_token` cookie from an owner session created only for this check. Signing that session out revokes it.                        |

Each provider must commit an npm lockfile. The runner installs its locked production dependencies with lifecycle scripts disabled, after the SSH credentials have been removed. The entrypoints are bundled into the API Worker in slot order and can import the shared workspace SDK. The provider checkouts, credentials and raw provider build output stay on the ephemeral runner. Update the corresponding pinned revision in the production environment when releasing provider changes. Review private source and its transitive dependencies before changing the pin.

The workflow builds and dry-runs both Worker bundles and boots the packaged API Worker locally before publishing. Only one production job runs at a time, and the job checks the current `main` revision before changing production. It deploys and verifies the API Worker first, then deploys and verifies the web Worker. It confirms that both deployments serve the version tagged with the release commit and checks the login page, API health endpoint and anonymous access to a protected endpoint. Wrangler preserves production dashboard variables with `--keep-vars`. Cloudflare holds the production runtime credentials and settings.

The release does not run database migrations. Apply them separately before releasing code that depends on them. Before publishing, the job checks migrations:

- With `MIGRATION_CHECK_DATABASE_URL`, it reads the newest applied migration and fails if the commit's journal has a newer entry, the entries Drizzle's migrator would apply.
- Without it, it compares the commit with the one the API Worker serves, or with the previous tip of `main` when that cannot be read. It fails if a migration file was added in between, or if neither commit is known, and warns that the schema was not checked otherwise. Until the secret is added, no release that adds a migration can pass this check.

Nothing is published when this check fails. Re-run the job after applying the migrations.

After the signed-out checks, the job opens Tracks Browse in the table view with `BROWSE_CHECK_SESSION_TOKEN` in headless Chrome. It fails if the first track row is not visible within 10 seconds of navigation start, or if production sends the session to the login page. The time is in the job summary. Without the secret, the step passes with a warning. Replace the secret when the session expires: sessions last 30 days and are extended when used.

If any step fails or the job is cancelled, a final step reports the commit each Worker serves, in the log and the job summary, and warns when either is not serving the release commit. A failure after the API deploy can leave the two Workers on different revisions. Check the existing release's database and runtime compatibility before retrying or rolling either Worker back.

## Access and runtime

Use separate production and development databases. Keep provider credentials server-side, disable public signup, and verify that unauthenticated requests cannot read the library or change jobs. Back up the database and its encryption key separately. Never run the development dispatcher or test suite against a production database.

## Dispatch and provider policy

Review pending jobs before enabling a provider. Test a single explicitly selected item and inspect its logs, request events and snapshot before releasing more work. Pausing dispatch does not cancel requests already in flight. Preserve request spacing, concurrency, account budgets and cooldowns across restarts. Do not automatically retry access denials or switch transports to bypass them.

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

The workflow builds and dry-runs both Worker bundles and boots the packaged API Worker locally before publishing. It deploys and verifies the API Worker first, then deploys and verifies the web Worker. It confirms that both deployments serve the version tagged with the release commit and checks the login page, API health endpoint and anonymous access to a protected endpoint. Wrangler preserves production dashboard variables with `--keep-vars`. Cloudflare holds the production runtime credentials and settings.

Production jobs run one at a time and each waits its turn (up to 100 can wait), so a commit whose checks passed is published even when `main` has moved on since. Turns are not always in commit order. Before building, and again before publishing, the job compares its commit with the commit each Worker serves, which is the tag on the served version:

- It publishes when neither Worker serves a newer commit. This includes a re-run for the commit already served, for example after changing a provider pin.
- It ends without publishing when either Worker serves a newer commit, because that release already contains this one.
- When a Worker serves something the job cannot place before its own commit (a version without a commit tag, a commit from another branch, or traffic split between versions), only the tip of `main` publishes.
- A commit that is no longer part of `main` is never published.

A job that does not publish says why in its log and summary. `.github/scripts/release-order.test.sh` tests these rules against a throwaway Git history and runs with the unit tests.

The release does not run database migrations. Apply them separately before releasing code that depends on them. Before publishing, the job checks migrations:

- With `MIGRATION_CHECK_DATABASE_URL`, it reads the newest applied migration and fails if the commit's journal has a newer entry, the entries Drizzle's migrator would apply.
- Without it, it compares the commit with the one the API Worker serves, or with the previous tip of `main` when that cannot be read. It fails if a migration file was added in between, or if neither commit is known, and warns that the schema was not checked otherwise. Until the secret is added, no release that adds a migration can pass this check.

Nothing is published when this check fails. Re-run the job after applying the migrations.

After the signed-out checks, the job opens Tracks Browse in the table view with `BROWSE_CHECK_SESSION_TOKEN` in headless Chrome. It fails if the first track row is not visible within 10 seconds of navigation start, or if production sends the session to the login page. The time is in the job summary. Without the secret, the step passes with a warning. Replace the secret when the session expires: sessions last 30 days and are extended when used.

Build and publish steps run silently. When a step on public code fails, such as the web Worker build or bundle, the shared schema, SDK or API declaration builds, or the web Worker deployment, the `deploy-production / deploy` job log shows the last 300 lines of its output directly above the `::error::` line that names the step. Open the failed step (usually **Build Worker bundles**) in the run to read it. GitHub masks the workflow's secrets in that output. Steps that read private provider source (provider dependency install, provider build preparation, API Worker typecheck, bundle, healthcheck and deployment) discard their output, because this repository's job logs are public. Reproduce those failures locally with the pinned provider checkouts.

If any step fails or the job is cancelled, a final step reports the commit each Worker serves, in the log and the job summary, and warns when either is not serving the release commit. A failure after the API deploy can leave the two Workers on different revisions. Check the existing release's database and runtime compatibility before retrying or rolling either Worker back.

## Production status

`pnpm production:status` prints what production is running and what its job queue is doing. It changes nothing. Run it from a checkout and pass the files that hold the production settings:

```bash
corepack pnpm production:status --env-file <deploy settings file> --env-file <production database file> --ref <remote>/main
```

It loads the workspace `.env` and `.env.local` the usual way, then reads each `--env-file` in order into its own settings, which never enter the process environment. Relative paths are resolved from the directory the command was run in. It reads:

| Setting                  | Used for                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | The account Wrangler reads deployments from. Wrangler uses its own sign-in, or `CLOUDFLARE_API_TOKEN` when set.                                          |
| `DATABASE_URL_UNPOOLED`  | A direct (not pooled) connection URL for the production database. Name another variable with `--database-url-env`. A role limited to `SELECT` is enough. |
| `--ref` (default `HEAD`) | The commit the served commits are compared with. Fetch first.                                                                                            |

The output has these sections:

- **Workers**: for the API and web Workers, the deployment time and each served version's commit tag and traffic share. When the commit is in the checkout, it also shows the commit subject and how many commits it is behind `--ref`. A release run can succeed without publishing when production already serves a newer commit, so this, not the run status, says what is live.
- **Jobs**: queued, running and failed `scrape_job` counts by provider and task, the oldest queued and longest running age per type, the oldest queued job's id, and the ids of the five latest failed jobs. Use those ids to find a failed job's saved request, response and snapshot.
- **Paused or blocked providers**: providers whose requests are halted after an access denial or are cooling down. The dispatcher's own pause switch is held by the API Worker's coordinator and is not read; the app's queue controls show it.
- **Syncs**: subscription and Last.fm sync states with their counts.
- **Library imports**: queued or running imports.
- **Slowest routes**: not read yet; see below.

Built-in providers keep their names. Every other provider, and its task names, is shown as a stable hash such as `private-3fa1c2 / task-9b0e44`, so the output can be pasted without naming private plugins. The command prints counts, ages, statuses and job ids only. It never prints connection details, keys, job scopes, error messages or library contents.

It is read-only by construction. Wrangler is called only for `deployments status` and `versions view`. The database session starts with `default_transaction_read_only=on`, runs its fixed `SELECT` statements inside a `READ ONLY` transaction with a 20-second statement timeout, checks that the transaction is read-only before the first query, and rolls back.

Route timings are not read. They exist only as `api.request` events in Workers Logs (see [query performance](query-performance.md)). Querying Workers Logs needs a token with the Workers Observability permission, which Wrangler's sign-in does not include. Use the Query Builder in the meantime.

The command exits with status 1 when a section could not be read and names that section, so a partial result is never shown as complete.

## Access and runtime

Use separate production and development databases. Keep provider credentials server-side, disable public signup, and verify that unauthenticated requests cannot read the library or change jobs. Back up the database and its encryption key separately. Never run the development dispatcher or test suite against a production database.

## Dispatch and provider policy

Review pending jobs before enabling a provider. Test a single explicitly selected item and inspect its logs, request events and snapshot before releasing more work. Pausing dispatch does not cancel requests already in flight. Preserve request spacing, concurrency, account budgets and cooldowns across restarts. Do not automatically retry access denials or switch transports to bypass them.

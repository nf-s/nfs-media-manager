# Production operations

For the Node server, follow the [self-hosting guide](getting-started.md#hosting-beyond-your-computer) and [job worker lifecycle](job-worker.md). Deployment-specific addresses, account settings, release records and operator notes do not belong in the public repository.

## Access and runtime

Use separate production and development databases. Keep provider credentials server-side, disable public signup, and verify that unauthenticated requests cannot read the library or change jobs. Back up the database and its encryption key separately. Never run the development dispatcher or test suite against a production database.

## Dispatch and provider policy

Review pending jobs before enabling a provider. Test a single explicitly selected item and inspect its logs, request events and snapshot before releasing more work. Pausing dispatch does not cancel requests already in flight. Preserve request spacing, concurrency, account budgets and cooldowns across restarts. Do not automatically retry access denials or switch transports to bypass them.

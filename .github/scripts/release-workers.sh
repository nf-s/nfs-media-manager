#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

quiet() {
  local description="$1"
  shift
  "$@" >/dev/null 2>&1 || fail "$description failed."
}

wrangler() {
  local package="$1"
  shift
  pnpm --filter "$package" exec wrangler "$@"
}

app_origin="$(node -e '
  const url = new URL(process.env.CLOUDFLARE_APP_URL);
  if (url.protocol !== "https:" || url.href !== url.origin + "/") process.exit(1);
  process.stdout.write(url.origin);
' 2>/dev/null)" || fail 'Configure the Cloudflare app HTTPS origin.'

resolve_provider() {
  local slot="$1" entrypoint="$2" checkout resolved
  [[ "$entrypoint" =~ ^[A-Za-z0-9_./-]+$ && "$entrypoint" != /* ]] ||
    fail "Configure a relative entrypoint file for provider $slot."
  checkout="$(realpath ".cloudflare/provider-$slot" 2>/dev/null)" ||
    fail "The pinned checkout for provider $slot is missing."
  resolved="$(realpath "$checkout/$entrypoint" 2>/dev/null)" ||
    fail "The configured entrypoint for provider $slot is missing."
  [[ "$resolved" == "$checkout/"* && -f "$resolved" ]] ||
    fail "The entrypoint for provider $slot does not resolve to a file inside its checkout."
  printf '%s' "$resolved"
}

install_provider_dependencies() {
  local slot="$1"
  local checkout=".cloudflare/provider-$slot"
  [[ -f "$checkout/package-lock.json" ]] ||
    fail "The pinned checkout for provider $slot is missing its npm lockfile."
  quiet "Provider $slot dependency install" npm --prefix "$checkout" ci \
    --omit=dev --ignore-scripts --no-audit --no-fund
}

build() {
  local provider_one provider_two
  provider_one="$(resolve_provider one "${PROVIDER_ONE_ENTRYPOINT:-}")" || exit 1
  provider_two="$(resolve_provider two "${PROVIDER_TWO_ENTRYPOINT:-}")" || exit 1

  install_provider_dependencies one
  install_provider_dependencies two
  # Allow private entrypoints to import the SDK from the API workspace.
  quiet 'Provider workspace dependency link' ln -s ../apps/server/node_modules .cloudflare/node_modules

  quiet 'Shared schemas build' pnpm --filter @repo/schemas build
  quiet 'Provider SDK build' pnpm --filter @repo/media-plugin-sdk build
  quiet 'API declarations build' pnpm --filter @repo/server build:types
  # The existing preparation script loads the server env schema. Its required
  # auth and encryption values can be ephemeral for a build without a database.
  local build_auth build_key
  build_auth="$(openssl rand -hex 32)"
  build_key="$(openssl rand -hex 32)"
  BETTER_AUTH_SECRET="$build_auth" MEDIA_ENCRYPTION_KEY="$build_key" MEDIA_PLUGIN_PATHS="$provider_one,$provider_two" \
    quiet 'Private provider build preparation' pnpm --filter @repo/server prepare:cloudflare
  quiet 'API Worker typecheck' pnpm --filter @repo/server typecheck:cloudflare
  quiet 'API Worker bundle' wrangler @repo/server deploy --dry-run --outdir ../../.cloudflare/server-build
  quiet 'Packaged API Worker healthcheck' pnpm --filter @repo/server exec tsx scripts/check-cloudflare-build.ts
  CLOUDFLARE_APP_URL="$app_origin" quiet 'Web Worker build' pnpm --filter web build:cloudflare
  quiet 'Web Worker bundle' wrangler web deploy --dry-run
}

verify_version() {
  local package="$1" label="$2" status version metadata
  status="$(wrangler "$package" deployments status --json 2>/dev/null)" ||
    fail "Could not read the deployed $label version."
  version="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' <<< "$status" 2>/dev/null)" ||
    fail "The $label Worker is not serving a single version."
  metadata="$(wrangler "$package" versions view "$version" --json 2>/dev/null)" ||
    fail "Could not read the deployed $label version metadata."
  jq -e --arg sha "$GITHUB_SHA" '.annotations["workers/tag"] == $sha' <<< "$metadata" >/dev/null 2>&1 ||
    fail "The active $label version does not match the checked revision."
}

smoke() {
  local health auth login
  health="$(curl -qfsS --max-time 15 "$app_origin/api/v1/healthcheck" 2>/dev/null)" || return 1
  jq -e '.statusCode == 200 and .data.message == "OK"' <<< "$health" >/dev/null 2>&1 || return 1
  auth="$(curl -qsS --max-time 15 --output /dev/null --write-out '%{http_code}' "$app_origin/api/v1/albums" 2>/dev/null)" || return 1
  login="$(curl -qsS --max-time 15 --output /dev/null --write-out '%{http_code}' "$app_origin/login" 2>/dev/null)" || return 1
  [[ "$auth" == 401 && "$login" == 200 ]]
}

require_workers_access() {
  if [[ ! ${CLOUDFLARE_ACCOUNT_ID:-} =~ ^[a-f0-9]{32}$ ||
        -z ${CLOUDFLARE_API_TOKEN:-} ||
        ! ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ ]]; then
    fail 'Configure the Workers account and dedicated deployment token.'
  fi
}

# Prints "<tag> <percentage>" for each version the Worker serves.
served_tags() {
  local package="$1" status version percentage tag
  status="$(wrangler "$package" deployments status --json 2>/dev/null)" || return 1
  jq -er '.versions[] | "\(.version_id) \(.percentage)"' <<< "$status" 2>/dev/null |
    while read -r version percentage; do
      tag="$(wrangler "$package" versions view "$version" --json 2>/dev/null </dev/null |
        jq -r '.annotations["workers/tag"] // "untagged"' 2>/dev/null)" || tag=unknown
      printf '%s %s\n' "${tag:-unknown}" "$percentage"
    done
}

check_migrations() {
  require_workers_access
  if [[ -n ${MIGRATION_CHECK_DATABASE_URL:-} ]]; then
    node .github/scripts/check-migrations.mjs
    return
  fi

  # Without database access, compare with the commit the API Worker serves,
  # or the previous tip of main, and refuse a release that adds a migration.
  local served base='' added
  served="$(served_tags @repo/server || true)"
  if [[ "$served" =~ ^([a-f0-9]{40})\ 100$ ]] &&
      git cat-file -e "${BASH_REMATCH[1]}^{commit}" 2>/dev/null; then
    base="${BASH_REMATCH[1]}"
  elif [[ ${PUSH_BEFORE:-} =~ ^[a-f0-9]{40}$ && ! $PUSH_BEFORE =~ ^0+$ ]] &&
      git cat-file -e "$PUSH_BEFORE^{commit}" 2>/dev/null; then
    base="$PUSH_BEFORE"
  fi
  [[ -n "$base" ]] ||
    fail 'Could not tell whether this release adds a migration, and MIGRATION_CHECK_DATABASE_URL is not set. Nothing was published.'
  added="$(git diff --no-renames --name-only --diff-filter=A "$base" "$GITHUB_SHA" -- 'apps/server/drizzle/*.sql')" ||
    fail 'Could not compare migrations with the served commit. Nothing was published.'
  if [[ -n "$added" ]]; then
    fail "This release adds migrations since ${base:0:7} ($(tr '\n' ' ' <<< "$added" | sed 's/ $//')) and MIGRATION_CHECK_DATABASE_URL is not set, so this job cannot confirm that production has applied them. Apply them, add the secret to the production environment, then re-run this job. Nothing was published."
  fi
  printf '::warning::No migration files were added since %s. The production schema was not checked: MIGRATION_CHECK_DATABASE_URL is not set.\n' "${base:0:7}"
}

check_browse() {
  if [[ -z ${BROWSE_CHECK_SESSION_TOKEN:-} ]]; then
    printf '::warning::Skipped the signed-in Browse check: BROWSE_CHECK_SESSION_TOKEN is not set.\n'
    return
  fi
  local modules="${RUNNER_TEMP:-/tmp}/browse-check"
  quiet 'Browser driver install' npm install --prefix "$modules" --no-save --no-audit --no-fund \
    --ignore-scripts playwright-core@1.64.1
  BROWSE_CHECK_MODULES="$modules" CLOUDFLARE_APP_URL="$app_origin" node .github/scripts/check-browse.mjs
}

# After a failed or cancelled release: say which commit each Worker serves.
report_served() {
  local package label served line mismatch=false
  for package in @repo/server web; do
    [[ "$package" == web ]] && label=web || label=API
    if ! served="$(served_tags "$package")" || [[ -z "$served" ]]; then
      line="The $label Worker's served version could not be read."
      mismatch=true
    else
      line="The $label Worker serves $(sed 's/ \([0-9.]*\)$/ (\1%)/' <<< "$served" | paste -sd ',' - | sed 's/,/, /g')."
      [[ "$served" == "${GITHUB_SHA:-} 100" ]] || mismatch=true
    fi
    printf '%s\n' "$line"
    if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
      printf '%s\n\n' "$line" >> "$GITHUB_STEP_SUMMARY"
    fi
  done
  if [[ "$mismatch" == true ]]; then
    printf '::warning::At least one Worker is not serving %s only. Check both before retrying or rolling back.\n' "${GITHUB_SHA:0:7}"
  fi
}

publish() {
  require_workers_access
  quiet 'API Worker deployment' wrangler @repo/server deploy --keep-vars --tag "$GITHUB_SHA"
  verify_version @repo/server API
  quiet 'Web Worker deployment' wrangler web deploy --keep-vars --tag "$GITHUB_SHA" \
    --var "APP_URL:$app_origin"
  verify_version web web

  for _ in {1..5}; do
    if smoke; then
      printf 'Verified both Worker versions and signed-out production smoke checks.\n'
      return
    fi
    sleep 5
  done
  fail 'Production smoke checks failed after deployment.'
}

case "${1:-}" in
  build) build ;;
  publish) publish ;;
  migrations) check_migrations ;;
  browse) check_browse ;;
  served) report_served ;;
  *) fail 'Specify build, migrations, publish, browse or served.' ;;
esac

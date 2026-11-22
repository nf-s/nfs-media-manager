#!/usr/bin/env bash
# Tests the release order check in release-workers.sh against a throwaway Git
# history, with wrangler and the GitHub CLI replaced by stand-ins.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-workers.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
state="$work/state"
mkdir -p "$work/bin" "$work/repo" "$state"

# Stand-in for `pnpm --filter <package> exec wrangler ...`. Each package's
# state file lists "<tag> <percentage>" per served version; no file means the
# deployment cannot be read.
cat > "$work/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --filter && "$3 $4" == 'exec wrangler' ]] || exit 2
[[ "$2" == web ]] && file="$STATE/web" || file="$STATE/api"
[[ -f "$file" ]] || exit 1
case "$5 $6" in
  'deployments status')
    jq -Rn '{versions: [inputs | split(" ") | {version_id: "v\(input_line_number)", percentage: (.[1] | tonumber)}]}' "$file"
    ;;
  'versions view')
    tag="$(sed -n "${7#v}p" "$file" | cut -d' ' -f1)"
    if [[ "$tag" == untagged ]]; then
      printf '{"annotations":{}}\n'
    else
      jq -n --arg tag "$tag" '{annotations: {"workers/tag": $tag}}'
    fi
    ;;
  *) exit 2 ;;
esac
STUB

# Stand-in for `gh api repos/<repository>/compare/<commit>...main --jq .status`.
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api && "$2" == repos/example/media/compare/*...main ]] || exit 2
cat "$STATE/main"
STUB
chmod +x "$work/bin/pnpm" "$work/bin/gh"

commit() {
  git -C "$work/repo" -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false \
    commit --quiet --allow-empty -m "$1"
  git -C "$work/repo" rev-parse HEAD
}

# first - second - third on main, with side branching off first.
git -C "$work/repo" init --quiet --initial-branch=main
first="$(commit first)"
second="$(commit second)"
third="$(commit third)"
git -C "$work/repo" checkout --quiet -b side "$first"
side="$(commit side)"
unknown=0000000000000000000000000000000000000001

failures=0

# expect <publish|skip|error> <description> <commit> <main status> <API served> <web served>
# A served value is "<tag> <percentage>" lines, or "unreadable".
expect() {
  local expected="$1" description="$2" sha="$3" main_status="$4" api="$5" web="$6" outcome output
  rm -f "$state"/*
  [[ "$main_status" == unreadable ]] || printf '%s\n' "$main_status" > "$state/main"
  [[ "$api" == unreadable ]] || printf '%s\n' "$api" > "$state/api"
  [[ "$web" == unreadable ]] || printf '%s\n' "$web" > "$state/web"
  : > "$work/output"
  if output="$(cd "$work/repo" && PATH="$work/bin:$PATH" STATE="$state" \
      GITHUB_SHA="$sha" GITHUB_REPOSITORY=example/media GITHUB_OUTPUT="$work/output" GITHUB_STEP_SUMMARY='' \
      CLOUDFLARE_APP_URL=https://app.example.invalid CLOUDFLARE_API_TOKEN=test \
      CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 \
      bash "$script" order 2>&1)"; then
    grep -qx 'publish=true' "$work/output" && outcome=publish || outcome=skip
  else
    grep -q 'publish=true' "$work/output" && outcome='error after allowing publish' || outcome=error
  fi
  if [[ "$outcome" == "$expected" ]]; then
    printf 'ok    %s\n' "$description"
  else
    printf 'FAIL  %s: expected %s, got %s\n%s\n' "$description" "$expected" "$outcome" "$output"
    failures=$((failures + 1))
  fi
}

expect publish 'a commit newer than production publishes after main has moved on' \
  "$second" ahead "$first 100" "$first 100"
expect publish 'the tip of main publishes' \
  "$third" identical "$first 100" "$second 100"
expect publish 'the served commit publishes again on a re-run' \
  "$second" ahead "$second 100" "$second 100"
expect skip 'an older commit does not replace a newer release' \
  "$second" ahead "$third 100" "$third 100"
expect skip 'an older commit does not replace a newer API Worker' \
  "$second" ahead "$third 100" "$first 100"
expect skip 'an older commit does not replace a newer web Worker' \
  "$second" ahead "$first 100" "$third 100"
expect skip 'the tip of main does not replace a newer release' \
  "$second" identical "$third 100" "$third 100"
expect skip 'a commit dropped from main does not publish' \
  "$second" diverged "$first 100" "$first 100"
expect skip 'a commit ahead of main does not publish' \
  "$third" behind "$first 100" "$first 100"
expect skip 'a commit behind the tip does not replace a release from another branch' \
  "$second" ahead "$side 100" "$side 100"
expect publish 'the tip of main replaces a release from another branch' \
  "$third" identical "$side 100" "$side 100"
expect skip 'a commit behind the tip does not replace an untagged release' \
  "$second" ahead 'untagged 100' "$first 100"
expect publish 'the tip of main replaces an untagged release' \
  "$third" identical 'untagged 100' "$first 100"
expect skip 'a commit behind the tip does not replace a commit missing from the checkout' \
  "$second" ahead "$unknown 100" "$first 100"
expect skip 'a commit behind the tip does not publish over a split deployment' \
  "$second" ahead "$first 50"$'\n'"$second 50" "$first 100"
expect error 'an unreadable Worker deployment fails' \
  "$second" ahead "$first 100" unreadable
expect error 'an unreadable main comparison fails' \
  "$second" unreadable "$first 100" "$first 100"

if ((failures > 0)); then
  printf '%d release order case(s) failed.\n' "$failures"
  exit 1
fi
printf 'All release order cases passed.\n'

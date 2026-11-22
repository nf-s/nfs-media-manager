#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

key_one=${PROVIDER_ONE_DEPLOY_KEY:-}
key_two=${PROVIDER_TWO_DEPLOY_KEY:-}
unset PROVIDER_ONE_DEPLOY_KEY PROVIDER_TWO_DEPLOY_KEY
if (shopt -s nocasematch; [[ "${PROVIDER_ONE_REPOSITORY:-}" == "${PROVIDER_TWO_REPOSITORY:-}" ]]); then
  fail 'Configure two different private provider repositories.'
fi
if [[ "$key_one" == "$key_two" ]]; then
  fail 'Configure a separate read-only deploy key for each provider repository.'
fi

ssh_dir="$(mktemp -d)"
trap 'rm -f -- "$ssh_dir/key" "$ssh_dir/known_hosts" "$ssh_dir/config"; rmdir -- "$ssh_dir"' EXIT
# GitHub's published Ed25519 host key.
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$ssh_dir/known_hosts"

cat > "$ssh_dir/config" <<CONF
Host github.com
    StrictHostKeyChecking yes
    UserKnownHostsFile "$ssh_dir/known_hosts"
    GlobalKnownHostsFile /dev/null
    HostKeyAlgorithms ssh-ed25519
    IdentityFile "$ssh_dir/key"
    IdentityAgent none
    IdentitiesOnly yes
    BatchMode yes
CONF

checkout_provider() {
  local slot="$1" repository="$2" revision="$3" key="$4"
  if [[ ! "$repository" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ||
        ! "$revision" =~ ^[a-f0-9]{40}$ || -z "$key" ]]; then
    fail "Configure the repository, full revision and read-only deploy key for provider $slot."
  fi
  printf '%s\n' "$key" > "$ssh_dir/key"

  local checkout=".cloudflare/provider-$slot"
  if ! {
    mkdir "$checkout" &&
      git -C "$checkout" init --quiet &&
      GIT_SSH_COMMAND="ssh -F '$ssh_dir/config'" \
        git -C "$checkout" fetch --quiet --depth=1 --no-tags \
          "ssh://git@github.com/$repository.git" "$revision" &&
      git -C "$checkout" checkout --quiet --detach FETCH_HEAD &&
      [[ "$(git -C "$checkout" rev-parse HEAD)" == "$revision" ]]
  } >/dev/null 2>&1; then
    fail "Could not check out the pinned revision for provider $slot."
  fi
}

mkdir -p .cloudflare
checkout_provider one "${PROVIDER_ONE_REPOSITORY:-}" "${PROVIDER_ONE_REVISION:-}" "$key_one"
checkout_provider two "${PROVIDER_TWO_REPOSITORY:-}" "${PROVIDER_TWO_REVISION:-}" "$key_two"

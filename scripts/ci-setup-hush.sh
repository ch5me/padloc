#!/usr/bin/env bash
set -euo pipefail

# Bootstrap Hush + sops in CI so deploy secrets resolve from the repo-local,
# stage-split Hush targets (hush-in-CI). The ONLY CI secret this needs is
# SOPS_AGE_KEY, which decrypts the repo's .hush files. The Cloudflare deploy
# token (governed ch5-padloc-<stage>) then comes from the wrangler-deploy-<stage>
# target — never from a shared Forgejo CLOUDFLARE_API_TOKEN secret.
#
# Usage: bash scripts/ci-setup-hush.sh [verify-target]
#   verify-target (optional): a Hush target name to assert resolves the
#   Cloudflare deploy keys before the job proceeds (fail fast, fail loud).

SOPS_VERSION="${SOPS_VERSION:-3.10.2}"
GO_BOOTSTRAP_VERSION="${GO_BOOTSTRAP_VERSION:-1.24.3}"
# 7.5.0 is the highest @chriscode/hush on the PUBLIC npm registry (7.6+ live only
# on the private npm.ch5.me). CI bootstraps hush from public npm so it needs no
# NPM_TOKEN, so this must stay a public version. Verified to read the repo's
# current v3 hush manifest (authored with 7.7.0; 7.5.0 read-compat confirmed).
HUSH_VERSION="${HUSH_VERSION:-7.5.0}"
DOWNLOAD_RETRIES="${DOWNLOAD_RETRIES:-5}"
VERIFY_TARGET="${1:-}"

if [ -z "${SOPS_AGE_KEY:-}" ]; then
  echo "SOPS_AGE_KEY Forgejo secret is required to decrypt repo-local Hush targets" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  x86_64) sops_arch="amd64"; go_arch="amd64" ;;
  aarch64|arm64) sops_arch="arm64"; go_arch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

apt_updated=0

apt_update_once() {
  if [ "$apt_updated" -eq 0 ]; then
    apt-get update -qq >/dev/null
    apt_updated=1
  fi
}

retry_command() {
  attempts="$1"
  shift
  attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$attempts" ]; then
      return 1
    fi
    sleep "$((attempt * 2))"
    attempt="$((attempt + 1))"
  done
}

download_with_retries() {
  url="$1"
  output="$2"
  retry_command "$DOWNLOAD_RETRIES" \
    curl -fsSL --retry "$DOWNLOAD_RETRIES" --retry-all-errors --retry-delay 2 --connect-timeout 20 \
    "$url" -o "$output"
}

install_sops_from_apt() {
  command -v apt-get >/dev/null 2>&1 || return 1
  apt_update_once
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sops >/dev/null || return 1
}

install_go_toolchain() {
  command -v apt-get >/dev/null 2>&1 || return 1
  apt_update_once
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git tar >/dev/null || return 1
  go_tarball="$(mktemp "${RUNNER_TEMP:-/tmp}/go-bootstrap.XXXXXX.tar.gz")"
  download_url="https://go.dev/dl/go${GO_BOOTSTRAP_VERSION}.linux-${go_arch}.tar.gz"
  download_with_retries "$download_url" "$go_tarball" || { rm -f "$go_tarball"; return 1; }
  rm -rf /usr/local/go
  tar -xzf "$go_tarball" -C /usr/local || { rm -f "$go_tarball"; return 1; }
  rm -f "$go_tarball"
  export PATH="/usr/local/go/bin:$PATH"
  command -v go >/dev/null 2>&1 || return 1
}

go_install_sops() {
  go_bin="$(command -v go 2>/dev/null)" || return 1
  retry_command "$DOWNLOAD_RETRIES" env GOBIN=/usr/local/bin \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GONOSUMDB= \
    "$go_bin" install "github.com/getsops/sops/v3/cmd/sops@v${SOPS_VERSION}" >/dev/null
}

install_sops_from_go_proxy() {
  command -v apt-get >/dev/null 2>&1 || return 1
  apt_update_once
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git >/dev/null || return 1
  if go_install_sops; then
    return 0
  fi
  install_go_toolchain || return 1
  go_install_sops
}

if ! command -v sops >/dev/null 2>&1; then
  if ! install_sops_from_apt && ! install_sops_from_go_proxy; then
    echo "Cannot install sops: apt package unavailable and Go proxy install failed for sops v${SOPS_VERSION} (${sops_arch}) after ${DOWNLOAD_RETRIES} attempts." >&2
    exit 1
  fi
fi

install_hush=0
if ! command -v hush >/dev/null 2>&1; then
  install_hush=1
else
  hush_current_version="$(hush --version 2>/dev/null || true)"
  if [ "$hush_current_version" != "$HUSH_VERSION" ]; then
    install_hush=1
  fi
fi

if [ "$install_hush" -eq 1 ]; then
  # Hush installs from the public npm registry (no repo NPM_TOKEN needed to bootstrap).
  # The repo .npmrc routes @chriscode -> private npm.ch5.me (needs auth), so force
  # the @chriscode scope to public npm on the CLI (highest npm config precedence)
  # to stay on the tokenless bootstrap path regardless of the checked-in .npmrc.
  npm_userconfig="$(mktemp "${RUNNER_TEMP:-/tmp}/hush-npmrc.XXXXXX")"
  {
    printf 'registry=https://registry.npmjs.org/\n'
  } > "$npm_userconfig"
  npm --userconfig "$npm_userconfig" install -g "@chriscode/hush@${HUSH_VERSION}" \
    --registry=https://registry.npmjs.org/ \
    --@chriscode:registry=https://registry.npmjs.org/ >/dev/null
fi

key_dir="${RUNNER_TEMP:-/tmp}/hush-age"
mkdir -p "$key_dir"
key_file="$key_dir/sops-age-key.txt"
umask 077
printf '%s\n' "$SOPS_AGE_KEY" > "$key_file"
export SOPS_AGE_KEY_FILE="$key_file"

if [ -n "${FORGEJO_ENV:-}" ]; then
  echo "SOPS_AGE_KEY_FILE=$key_file" >> "$FORGEJO_ENV"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "SOPS_AGE_KEY_FILE=$key_file" >> "$GITHUB_ENV"
fi

hush config active-identity ci >/dev/null

if [ -n "$VERIFY_TARGET" ]; then
  hush verify-target "$VERIFY_TARGET" \
    --require CLOUDFLARE_API_TOKEN \
    --require CLOUDFLARE_ACCOUNT_ID
fi

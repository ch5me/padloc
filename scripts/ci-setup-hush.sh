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
# 7.5.0 is the highest @chriscode/hush on the PUBLIC npm registry (7.6+ live only
# on the private npm.ch5.me). CI bootstraps hush from public npm so it needs no
# NPM_TOKEN, so this must stay a public version. Verified to read the repo's
# current v3 hush manifest (authored with 7.7.0; 7.5.0 read-compat confirmed).
HUSH_VERSION="${HUSH_VERSION:-7.5.0}"
DOWNLOAD_RETRIES="${DOWNLOAD_RETRIES:-5}"
DOWNLOAD_TIMEOUT_SECONDS="${DOWNLOAD_TIMEOUT_SECONDS:-120}"
VERIFY_TARGET="${1:-}"

if [ -z "${SOPS_AGE_KEY:-}" ]; then
  echo "SOPS_AGE_KEY Forgejo secret is required to decrypt repo-local Hush targets" >&2
  exit 1
fi

# sops is not a Debian/Ubuntu apt package (that path always failed here), and
# `go install github.com/getsops/sops/v3/cmd/sops@...` compiles sops and its
# whole dependency tree from source on every run, since ephemeral job
# containers start with a cold GOCACHE/GOMODCACHE every time. Measured live:
# two containers each running that `go install` concurrently, 52.8% and 59.3%
# CFS throttling and 60-77 threads inside a 2-CPU cgroup quota, because Go
# sizes GOMAXPROCS to the host's 8 CPUs while confined to 2. Install the
# prebuilt release binary instead, pinned by checksum, following the pattern
# already proven at folio-db's scripts/ci-setup-hush.sh.
case "${SOPS_VERSION}:$(uname -m)" in
  3.10.2:x86_64) sops_arch="amd64"; sops_sha256="79b0f844237bd4b0446e4dc884dbc1765fc7dedc3968f743d5949c6f2e701739" ;;
  3.10.2:aarch64|3.10.2:arm64) sops_arch="arm64"; sops_sha256="e91ddc04e6a78f5aed9e4fc347a279b539c43b74d99e6b8078e2f2f6f5b309f5" ;;
  *) echo "Unsupported sops release: v${SOPS_VERSION} for $(uname -m); add its verified checksum first" >&2; exit 1 ;;
esac

download_with_retries() {
  url="$1"
  output="$2"
  curl -fsSL --retry "$DOWNLOAD_RETRIES" --retry-all-errors --retry-delay 2 \
    --connect-timeout 20 --max-time "$DOWNLOAD_TIMEOUT_SECONDS" --retry-max-time "$DOWNLOAD_TIMEOUT_SECONDS" \
    "$url" -o "$output"
}

install_sops_release() {
  sops_binary="$(mktemp "${RUNNER_TEMP:-/tmp}/sops.XXXXXX")"
  download_url="https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${sops_arch}"
  download_with_retries "$download_url" "$sops_binary" || { rm -f "$sops_binary"; return 1; }
  printf '%s  %s\n' "$sops_sha256" "$sops_binary" | sha256sum --check --status \
    || { rm -f "$sops_binary"; return 1; }
  install -m 0755 "$sops_binary" /usr/local/bin/sops
  rm -f "$sops_binary"
}

if ! command -v sops >/dev/null 2>&1 || ! sops --help >/dev/null 2>&1; then
  if ! install_sops_release; then
    echo "Cannot install verified sops v${SOPS_VERSION} (${sops_arch}) within ${DOWNLOAD_TIMEOUT_SECONDS}s." >&2
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

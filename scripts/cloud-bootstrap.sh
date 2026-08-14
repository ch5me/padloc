#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

timeout_bin=""
for candidate in timeout gtimeout; do
    if command -v "$candidate" >/dev/null 2>&1; then
        timeout_bin="$candidate"
        break
    fi
done
if [[ -z "$timeout_bin" ]]; then
    echo "CLOUD_BOOTSTRAP_ERROR code=timeout_unavailable exit=78" >&2
    exit 78
fi

run_stage() {
    local name="$1"
    local limit="$2"
    shift 2

    local started status elapsed
    started="$(date +%s)"
    printf 'CLOUD_STAGE %s t+0s status=started\n' "$name"
    set +e
    "$timeout_bin" --signal=TERM --kill-after=5s "$limit" "$@"
    status=$?
    set -e
    elapsed=$(( $(date +%s) - started ))

    if [[ "$status" -ne 0 ]]; then
        printf 'CLOUD_STAGE %s t+%ss status=failed exit=%s duration=%ss\n' \
            "$name" "$elapsed" "$status" "$elapsed" >&2
        exit "$status"
    fi
    printf 'CLOUD_STAGE %s t+%ss status=passed duration=%ss\n' \
        "$name" "$elapsed" "$elapsed"
}

case "$(uname -s)" in
    Linux|Darwin) ;;
    *)
        echo "CLOUD_BOOTSTRAP_ERROR code=unsupported_host exit=78 host=$(uname -s)" >&2
        exit 78
        ;;
esac

# shellcheck disable=SC2016
node -e '
const major = Number(process.versions.node.split(".")[0]);
if (major !== 24) throw new Error(`Node 24.x required; found ${process.version}`);
'
npm_major="$(npm --version | cut -d. -f1)"
if [[ "$npm_major" != "11" ]]; then
    echo "CLOUD_BOOTSTRAP_ERROR code=npm_version exit=78 expected=11.x actual=$(npm --version)" >&2
    exit 78
fi
if [[ -z "${NPM_TOKEN:-}" ]]; then
    echo "CLOUD_BOOTSTRAP_ERROR code=missing_npm_token exit=78" >&2
    exit 78
fi

export CI=1
export NPM_CONFIG_USERCONFIG="$root/.npmrc"
run_stage dependencies 1200s env -u ESBUILD_BINARY_PATH npm ci --ignore-scripts
run_stage workspaces 600s bash scripts/ci-bootstrap-workspaces.sh

printf 'CLOUD_BOOTSTRAP_PASS platform=%s node=%s npm=%s\n' \
    "$(uname -s)" "$(node --version)" "$(npm --version)"

#!/usr/bin/env bash
set -euo pipefail

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
    echo "CLOUD_VERIFY_ERROR code=timeout_unavailable exit=78" >&2
    exit 78
fi

stage_timeout="${CLOUD_WORK_STAGE_TIMEOUT:-600s}"
run_stage() {
    local name="$1"
    shift

    printf 'CLOUD_VERIFY_STAGE %s status=started\n' "$name"
    local status
    set +e
    "$timeout_bin" --signal=TERM --kill-after=5s "$stage_timeout" "$@"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
        printf 'CLOUD_VERIFY_STAGE %s status=passed\n' "$name"
        return
    fi

    printf 'CLOUD_VERIFY_STAGE %s status=failed exit=%s\n' "$name" "$status" >&2
    exit "$status"
}

case "$(uname -s)" in
    Linux|Darwin) ;;
    *)
        echo "CLOUD_VERIFY_ERROR code=unsupported_host exit=78 host=$(uname -s)" >&2
        exit 78
        ;;
esac

test -f node_modules/lerna/cli.js || {
    echo "CLOUD_VERIFY_ERROR code=dependencies_absent exit=78 run=./scripts/cloud-bootstrap.sh" >&2
    exit 78
}

# shellcheck disable=SC2016
node -e '
const major = Number(process.versions.node.split(".")[0]);
if (major !== 24) throw new Error(`Node 24.x required; found ${process.version}`);
'

printf 'CLOUD_PLATFORM_SKIP platform=ios reason=requires_owned_apple_runner\n'
printf 'CLOUD_PLATFORM_SKIP platform=macos reason=requires_owned_apple_runner\n'
printf 'CLOUD_PLATFORM_SKIP platform=windows reason=unsupported_no_owned_runner\n'
printf 'CLOUD_PLATFORM_SKIP platform=android reason=requires_android_sdk_lane\n'
printf 'CLOUD_PLATFORM_SKIP platform=linux-desktop reason=requires_desktop_system_libraries_lane\n'

run_stage formatting env FORMAT_BASE_SHA=HEAD FORMAT_INCLUDE_WORKTREE=1 npm run prettier:check:changed
run_stage contracts bash -lc 'npm run runtime-config:check && npm run theme:check'
run_stage worker npm --prefix packages/worker run test:ci
run_stage extension npm --prefix packages/extension test
run_stage extension-build bash -lc \
    'PL_BUILD_ENV=production PL_SERVER_URL=https://api-pad-staging.ch5.me npm run web-extension:build && npm --prefix packages/extension run preflight:dist'
run_stage pwa-build bash -lc \
    'PL_BUILD_ENV=production PL_SERVER_URL=https://api-pad-staging.ch5.me PL_PWA_URL=https://pad-staging.ch5.me npm run pwa:build && npm run pwa:check'

printf 'CLOUD_VERIFY_PASS platform=%s\n' "$(uname -s)"

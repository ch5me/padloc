#!/usr/bin/env bash
set -euo pipefail

git rev-parse --is-inside-work-tree >/dev/null || {
    echo "Changed-format check requires a Git worktree." >&2
    exit 78
}

base="${FORMAT_BASE_SHA:-}"
if [[ -z "$base" ]]; then
    if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
        git fetch --no-tags --depth=1 origin "$GITHUB_BASE_REF"
        base="origin/$GITHUB_BASE_REF"
    elif git rev-parse HEAD^ >/dev/null 2>&1; then
        base="HEAD^"
    else
        base="HEAD"
    fi
fi

files=()
while IFS= read -r file; do
    files+=("$file")
done < <(
    {
        git diff --name-only --diff-filter=ACMR "$base" HEAD -- \
            '.cloud-work/**' '.forgejo/workflows/**' 'config/**' 'package.json' \
            'packages/*/package.json' 'packages/*/src/**' 'packages/*/test/**' \
            'packages/*/test-harness/**' 'scripts/**'
        if [[ "${FORMAT_INCLUDE_WORKTREE:-0}" == "1" ]]; then
            git diff --name-only --diff-filter=ACMR HEAD -- \
                '.cloud-work/**' '.forgejo/workflows/**' 'config/**' 'package.json' \
                'packages/*/package.json' 'packages/*/src/**' 'packages/*/test/**' \
                'packages/*/test-harness/**' 'scripts/**'
            git ls-files --others --exclude-standard -- \
                '.cloud-work/**' '.forgejo/workflows/**' 'config/**' 'package.json' \
                'packages/*/package.json' 'packages/*/src/**' 'packages/*/test/**' \
                'packages/*/test-harness/**' 'scripts/**'
        fi
    } |
        sort -u |
        while IFS= read -r file; do
            if [[ -f "$file" && "$file" =~ \.(css|graphql|html|js|json|jsonc|jsx|md|mjs|scss|ts|tsx|yaml|yml)$ ]]; then
                printf '%s\n' "$file"
            fi
        done
)

if ((${#files[@]} == 0)); then
    echo "No changed Prettier-supported files."
    exit 0
fi

printf 'Checking formatting for %d changed file(s).\n' "${#files[@]}"
npx prettier --check -- "${files[@]}"

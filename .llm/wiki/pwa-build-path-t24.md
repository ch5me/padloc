# PWA Build Path — T24 Unblock

## Problem

The PWA build path was broken because:

1. `packages/core/package.json` and `packages/locale/package.json` were
   **missing entirely** from the repo (no files at root of those directories).
2. Without `package.json` files, `lerna bootstrap` could not create symlinks for
   `@padloc/core` and `@padloc/locale` into dependent package `node_modules/`.
3. `packages/app/node_modules` did not exist (no deps installed since bootstrap
   was incomplete).
4. `packages/pwa/package.json` had no `"scripts"` section, so
   `lerna run build --scope @padloc/pwa` was a no-op.
5. `packages/pwa/node_modules/@padloc/` was empty — no local package resolution.

## Fix Applied

### 1. Created minimal `packages/core/package.json`

```json
{
    "name": "@padloc/core",
    "version": "4.3.0",
    "private": true,
    "dependencies": {
        "@padloc/locale": "4.3.0",
        "date-fns": "2.22.1"
    }
}
```

### 2. Created minimal `packages/locale/package.json`

```json
{
    "name": "@padloc/locale",
    "version": "4.3.0",
    "private": true
}
```

### 3. Added scripts to `packages/pwa/package.json`

Added `"build"`, `"start"`, `"build_and_start"`, and `"dev"` scripts. The real
build command is:

```
NODE_OPTIONS=--openssl-legacy-provider webpack --config webpack.config.js
```

### 4. Added `@padloc/app` and `@padloc/core` as dependencies in PWA

### 5. Ran scoped lerna bootstrap

```
npx lerna bootstrap --scope '@padloc/pwa' --scope '@padloc/app' --scope '@padloc/core' --scope '@padloc/locale' --ignore-prepublish --no-ci
```

This created the symlink chain:

- `packages/pwa/node_modules/@padloc/app` → `../../../app`
- `packages/pwa/node_modules/@padloc/core` → `../../../core`
- `packages/app/node_modules/@padloc/core` → `../../../core`
- `packages/app/node_modules/@padloc/locale` → `../../../locale`
- `packages/core/node_modules/@padloc/locale` → `../../../locale`

Also installed `packages/app/node_modules` deps: `lit`, `workbox-*`, `date-fns`,
`lit-element`, etc.

## Verified Build Commands

### Direct webpack (from `packages/pwa/`):

```
NODE_OPTIONS=--openssl-legacy-provider PL_SERVER_URL="http://127.0.0.1:18770" PL_PWA_PORT=18080 npx webpack --config webpack.config.js
```

### Lerna (from repo root):

```
npm run pwa:build
```

Both produce: **47 assets, 879 modules, webpack compiled successfully** in ~6s.

Output in `packages/pwa/dist/`: `index.html`, `main.js`, `sw.js`, chunk files,
fonts, manifest, favicon.

## Root Cause

`packages/core/` and `packages/locale/` had no `package.json` files at their
root. The repo tree shows `src/`, `node_modules/`, and `vendor/` subdirectories
but no root-level files. Git likely excluded them or they were never committed.
Without `package.json`, lerna cannot identify them as packages to symlink, which
cascades into all downstream packages failing to resolve `@padloc/*` imports.

## Gotchas for T24

- Server bootstrap still fails (native `leveldown` build requires Python
  distutils + Node 16.x compatible toolchain) — but this doesn't affect the PWA
  build path.
- Use `--scope` flags to avoid server/bootstrap failures during PWA-only work.
- `NODE_OPTIONS=--openssl-legacy-provider` is required (webpack 5.52.0 +
  webpack-pwa-manifest uses legacy crypto APIs).

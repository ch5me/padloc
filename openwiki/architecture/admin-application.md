---
type: application
title: Admin application
description: Administrative client routes, access-state gating, shared package relationships, and build entrypoints.
tags: [admin, application, routes]
---
# Admin Application

`packages/admin/src/app.ts` defines `pl-admin-app` and its `start`, `unlock`, `login`, `accounts`, `orgs`, and `logs` routes. `accounts.ts`, `orgs.ts`, and `logs.ts` implement administrative views and API calls. The app installs the shared browser platform and reuses `@padloc/core` and `@padloc/app` contracts rather than owning vault cryptography.

Route/access state must gate administrative surfaces: unauthenticated users remain in login/start flows and locked sessions must unlock before protected account, organization, or log views. Its webpack build and runtime configuration are package-owned; inspect `packages/admin/package.json` and its webpack config before changing entrypoints. Keep Admin API changes aligned with core authorization and Worker routes. Focused coverage is package tests where present plus changed-only validation and Worker route tests for backend changes.

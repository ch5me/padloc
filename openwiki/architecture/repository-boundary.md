---
type: architecture overview
title: Repository boundary
description: CH5 Auth ownership, neighboring product boundaries, package map, and maintenance scope.
tags: [architecture, boundaries, packages]
---
# Repository Boundary

CH5 Auth is a CH5-maintained fork of Padloc. It owns encrypted vault data, the Cloudflare API, client security behavior, deployment, and release cadence. Firefly/ELF owns the shared product shell, identity, billing, and agent runtime. Magic Browser owns browser execution and redacted proof. Hush stores operator and deployment secrets, never user vault records.

The repository packages shared behavior in `packages/core`, UI components in `packages/app`, translations in `packages/locale`, the Worker in `packages/worker`, the PWA in `packages/pwa`, and additional Admin, extension, Cordova, Electron, Tauri, and legacy Node-server surfaces. See [runtime architecture](runtime-architecture.md) for composition and [sharp edges](../operations/sharp-edges.md) before editing.

```mermaid
flowchart LR
    Firefly["Firefly ELF shell identity billing"] --> SSO["CH5 Auth SSO verification"]
    PWA["PWA native extension"] --> Core["core app crypto vault"]
    Core --> Worker["Cloudflare Worker API"]
    Worker --> Data["D1 R2 KV Durable Objects"]
    Magic["Magic Browser execution"] -. "redacted proof" .-> Firefly
    Hush["Hush operator secrets"] -. "deploy/auth material" .-> Worker
```
Caption: CH5 Auth shares product workflows with neighbors while retaining the encrypted-data and deployment boundary.

Maintenance mode means security fixes, dependency/runtime upkeep, upstream compatibility, and regression-proof maintenance continue; broad new product development belongs in the appropriate federated application.

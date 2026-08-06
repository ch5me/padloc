---
type: release model
title: Public release channels
description: Release manifest contracts, staging and stable promotion, immutable artifacts, extension packaging, and pointer rollback.
tags: [releases, manifests, extensions]
---
# Public Release Channels

`config/release-manifest.schema.json` defines release provenance, version, channel, source SHA, toolchain, dependency lock, notes, artifact checksum/size, signature state, notarization, and platform compatibility. Build/validate/notes/canary commands are `npm run release:manifest:build`, `npm run release:manifest:validate`, `npm run release:notes`, and `npm run release:canary -- <manifest-url>`.

Staging may publish unsigned extension artifacts; stable promotion is human-approved and must promote identical downloaded bytes from an immutable staging record. Immutable records use release/version plus SHA tags, while moving `staging-latest` and `stable-latest` pointers provide discovery. Rollback moves a stable pointer to a previous immutable manifest; historical bytes are not rebuilt.

`config/platform-support.json` is the support truth. Do not infer release readiness from a build job: native passkey integration remains blocked, and platform signing/notarization claims require manifest evidence. Extension packaging uses the build and preflight scripts plus checksum/download canaries.

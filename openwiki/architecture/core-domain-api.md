---
type: domain model
title: Core domain and API
description: Core RPC surface and authorization-sensitive account, vault, organization, invite, provisioning, and synchronization behavior.
tags: [core, api, vaults, organizations]
---
# Core Domain and API

`packages/core/src/api.ts` defines request/response handlers; `packages/core/src/server.ts` maps requests into authenticated context, storage, provisioning, and logging. `account.ts`, `vault.ts`, `org.ts`, `invite.ts`, `directory.ts`, `provisioning.ts`, and `session.ts` own domain state. The Worker transport is only an adapter: authorization and domain invariants remain in core.

Vault records are encrypted client-owned data with revisions and synchronization semantics. Organization membership, roles, invitations, and exchanged keys are authorization-sensitive; multi-organization isolation must hold for every read and mutation. Provisioning and seat allocation constrain organization membership without becoming a source of vault keys. Attachments are linked to vault ownership and handled by Worker R2 storage.

Change surfaces: update API definitions and the corresponding `Server` handler, storage mapping, client method generation, and focused tests. Worker evidence includes `run-vault-crud-e2e.mjs`, `run-multi-org-isolation-e2e.mjs`, `run-org-seat-quota-e2e.mjs`, and `run-firefly-seat-sync-e2e.mjs`. Validate with the narrowest runner, then `npm --prefix packages/worker run test:ci` when cross-domain behavior changes.

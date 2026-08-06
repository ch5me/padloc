---
type: integration
title: Firefly integration boundary
description: Verification-only Firefly SSO and bearer-protected organization seat synchronization owned by the Worker boundary.
tags: [firefly, sso, provisioning, integration]
---
# Firefly Integration Boundary

`packages/worker/src/firefly-sso.ts` implements `POST /v1/firefly-sso/verify`. It verifies a Firefly token against configured JWKS, issuer, and audience, but deliberately does not create accounts, log users in, establish a vault session, or handle vault-key material. Firefly remains the owner of shared identity and billing.

`packages/worker/src/firefly-seat-sync.ts` implements `POST /admin/vault-org-seats`, protected by `FIREFLY_SEAT_SYNC_SECRET`. It passes seat allocation data to `OrgAwareProvisioner`; core then enforces organization seat behavior. Invalid claims, missing configuration, bad bearer secrets, and provisioning failures return explicit errors and must not partially establish auth state.

Focused tests are `run-firefly-seat-sync-e2e.mjs`, multi-org isolation, and seat quota suites. Changes must preserve the boundary: SSO verification is an assertion consumed by an integration, not a login shortcut; seat sync changes billing-derived capacity, not encrypted vault content.

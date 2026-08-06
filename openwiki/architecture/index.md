# Files

- [Admin application](admin-application.md) - Administrative client routes, access-state gating, shared package relationships, and build entrypoints.
- [Authentication protocols](authentication.md) - Email, TOTP, WebAuthn, public-key, OAuth, recovery, provisioning, device trust, and session boundaries.
- [Core domain and API](core-domain-api.md) - Core RPC surface and authorization-sensitive account, vault, organization, invite, provisioning, and synchronization behavior.
- [Core application lifecycle](core-lifecycle.md) - App state initialization, persistence, lock lifecycle, synchronization, and UI readiness barriers.
- [Firefly integration boundary](firefly-integration.md) - Verification-only Firefly SSO and bearer-protected organization seat synchronization owned by the Worker boundary.
- [Localization package](localization.md) - Runtime translation loading, extraction, wordlists, package consumers, and translation-drift validation.
- [Node server and Docker runtime](node-server.md) - Legacy Node server composition, backend integrations, HTTP behavior, and Compose/nginx deployment boundary.
- [Repository boundary](repository-boundary.md) - CH5 Auth ownership, neighboring product boundaries, package map, and maintenance scope.
- [Runtime architecture](runtime-architecture.md) - Client entrypoints, shared core contracts, Worker composition, and Cloudflare resource topology.
- [Security runtime invariants](security-runtime.md) - Session authority, cryptographic provider behavior, locking, attachment integrity, and fail-closed integration rules.
- [Cloudflare Worker composition](worker-composition.md) - Worker fetch entrypoint, special routes, lazy core server construction, bindings, and fallback behavior.
- [Worker storage and lifecycle](worker-storage.md) - D1 object storage, R2 attachment coordination, KV semantics, Durable Object locks, migrations, and partial failure behavior.
- [Worker HTTP transport](worker-transport.md) - HTTP/RPC framing, route behavior, request validation, idempotency, rate limiting, errors, and metrics.

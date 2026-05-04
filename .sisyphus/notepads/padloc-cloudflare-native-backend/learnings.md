# Learnings — padloc-cloudflare-native-backend

## 2026-05-04: T4 Architecture ADRs

- The existing `packages/server/src/config.ts` defines a deeply nested config
  hierarchy (`PL_DATA_BACKEND`, `PL_DATA_POSTGRES_HOST`, etc.) that maps cleanly
  to Cloudflare Wrangler environment bindings. The key insight is that the
  current config's "backend selector" pattern (e.g., `PL_DATA_BACKEND=postgres`)
  must be replaced with direct binding access in Workers (e.g.,
  `env.DB.prepare(...)`) rather than a config-driven factory pattern.

- ADR-001 anti-goals need to be explicit because the repo already has
  DigitalOcean App Platform deployment (`.do/deploy.template.yaml`) and Docker
  Compose examples (`docs/examples/hosting/docker/`). These are not just legacy
  files -- someone might try to adapt them. The ADR must explicitly state they
  are superseded.

- Feature scope for WebAuthn is "required-parity-gated" meaning it ships if the
  library works on Workers' Web Crypto API. This is the only feature with a
  conditional gate. All others are definitive Required/Defer/Drop.

- KV is explicitly non-authoritative in ADR-002. This is a security decision:
  any system that reads KV to validate session truth creates a race condition
  where a stale KV entry could bypass auth. D1 must always be checked for
  auth-critical paths.

- Durable Objects replace the in-memory `_requestQueue` at
  `packages/core/src/server.ts:2188`. This is not optional -- it is required for
  correctness when the backend has multiple concurrent requests hitting the same
  account.

- The environment topology uses a 3-tier model: dev (local wrangler), preview
  (branch-based), production (main/tag). Preview and production share the same
  codebase but never the same D1/R2/KV resources.

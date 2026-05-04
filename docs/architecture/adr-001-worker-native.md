# ADR-001: Worker-Native Only

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration

## Decision

The Padloc backend runs exclusively on Cloudflare Workers. There is no VPS, LXC,
Docker container, Node.js emulation, or sidecar process in the architecture.

## Rationale

Padloc v4 ships as a Node.js server (`@padloc/server`) that uses LevelDB,
MongoDB, PostgreSQL, or S3 for persistence, and SMTP for email delivery. The
migration replaces all Node.js dependencies with Cloudflare-native equivalents:

| Node.js Component        | Cloudflare Replacement                        |
| ------------------------ | --------------------------------------------- |
| Node.js runtime          | Cloudflare Workers (Fetch API, Web Standards) |
| LevelDB / MongoDB / PG   | D1 (SQLite-backed relational storage)         |
| S3 / filesystem          | R2 (S3-compatible object storage)             |
| In-memory request queues | Durable Objects (per-account/org locks)       |
| SMTP email               | Resend API (worker-native HTTP calls)         |
| Mixpanel analytics       | Dropped (v1)                                  |
| Stripe billing           | Dropped (v1)                                  |
| SCIM directory sync      | Deferred (v1)                                 |
| OAuth provisioning       | Deferred (v1)                                 |

## Anti-Goals

These are explicitly **not** part of this architecture:

- Docker containers for the Padloc backend
- LXC/VM hosting (Proxmox, Hetzner, or otherwise)
- Node.js compatibility mode on Workers
- Reverse proxy to a Node.js backend
- Sidecar processes for heavy computation
- Hybrid deployments that split logic between edge and origin
- Kubernetes, ECS, or any container orchestration

## Consequences

### Positive

- Zero cold start latency (Workers have 0ms cold start by design)
- No server provisioning, patching, or Docker image management
- Automatic global edge distribution
- Cost scales with requests, not uptime
- Simplified CI/CD through Wrangler

### Negative

- Workers have CPU time limits per request (10ms free tier, 50ms paid). Heavy
  operations (crypto hashing, key stretching) must use async patterns or be
  delegated to client-side computation.
- Bundle size constraints require removal of Node.js-only dependencies.
- No filesystem access. All storage goes through D1 or R2 bindings.

## Verification

All existing v4 hosting documentation referencing Docker, Docker Compose,
`.do/deploy.template.yaml`, or Node.js execution is superseded by this ADR and
will be replaced by Cloudflare-native deployment guides.

## References

- `.sisyphus/plans/padloc-cloudflare-native-backend.md`
- `packages/server/src/config.ts` (current config surface to remap)

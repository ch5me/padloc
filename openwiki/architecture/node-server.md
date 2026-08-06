---
type: service architecture
title: Node server and Docker runtime
description: Legacy Node server composition, backend integrations, HTTP behavior, and Compose/nginx deployment boundary.
tags: [node-server, docker, legacy, integrations]
---
# Node Server and Docker Runtime

`packages/server/src/init.ts` is the Node composition root. It selects LevelDB, MongoDB, Postgres, or memory storage; attachment backends; SMTP or other email; logging backends; authentication; and provisioning integrations. The same boundary includes SCIM/directory provisioning, OAuth and Stripe provisioning, and `NodeLegacyServer` compatibility paths. Core owns domain authorization; Node server owns adapter selection and external-service wiring.

`packages/server/src/transport/http.ts` provides the Node HTTP entrypoint with health behavior, CORS, request-size handling, legacy GET behavior, and serialized POST transport. It is not identical to Worker transport, so do not assume Worker routes, binding semantics, or error behavior transfer unchanged. `init.ts` also selects SCIM/directory provisioning, OAuth and Stripe provisioners, SMTP/email, MongoDB/Postgres/LevelDB logging, and `NodeLegacyServer`; each integration can change startup requirements and external writes while core remains the owner of authorization. The Node `Server` authentication path signs responses, serializes account/org work through its queue, logs requests, and maps failures to `Response.error`.

`docker-compose.yml` runs server, PWA, and nginx with persistent volumes for attachments/logs/PWA output; `Dockerfile-server`, `Dockerfile-pwa`, and `nginx/` define packaging. Representative tests live under `packages/server/test`; changes to backend selection or external integrations need the corresponding adapter tests and Docker build validation.

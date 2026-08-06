---
type: security architecture
title: Security runtime invariants
description: Session authority, cryptographic provider behavior, locking, attachment integrity, and fail-closed integration rules.
tags: [security, crypto, sessions, integrity]
---
# Security Runtime Invariants

D1 is authoritative for session validity; KV must not decide revocation. `packages/worker/src/session.ts` reads once, checks revocation/expiry, reconstructs session key/device data, and touches usage after processing. HTTP and session rate limits are separate mechanisms. `AccountLockDO` serializes mutations and sorts multi-identity locks.

`WorkerCryptoProvider` maps Padloc crypto contracts to Web Crypto: PBKDF2, AES-GCM, HMAC, RSA-OAEP, and RSA-PSS are supported; AES-CCM is not. Key serialization and constant-time verification preserve client compatibility. Attachment reads recompute hashes. HQ telemetry rejects external `sentry.io` and must not receive vault secrets.

Passkey and agentic-autofill flows fail closed: raw secrets must not enter logs, command arguments, screenshots, or durable browser proof. Focused checks include session contract, crypto parity, logging redaction, attachment lifecycle, passkey proof, and extension readiness.

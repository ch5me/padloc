# Use My AI Permission Engine v2 - Implementation Plan

Source: `2026-09-17-use-my-ai-permission-engine-v2.md`

## Delivery sequence

1. **Deterministic permission core**
   - Add runtime-validated policy, operation, recipient, target, grant, lease, and lifecycle types.
   - Evaluate hard denies, exact origin/frame/document bindings, delegation bounds, expiry, revocation generation, use limits, and mandatory confirmation independently of approval mode.
   - Return stable reason codes and fail closed for missing, stale, ambiguous, or contradictory authority.

2. **Secret-blind direct fill**
   - Replace value-bearing planner responses with session-bound source and field references.
   - Mint short-lived execution grants only after approval or a matching standing policy; resolve values solely inside the unlocked extension executor.
   - Revalidate and reserve each field use before the DOM write, return receipt-only results, and keep submission on a separate grant.

3. **Policies, revocation, and modes**
   - Add narrowly scoped per-origin/per-item standing policies and `plan`, `manual`, `auto`, `dontAsk`, and `bypassPrompts` behavior without weakening hard denies.
   - Implement parent-aware revocation, monotonic policy/revocation revisions, bounded leases, one-shot concurrency protection, restart-safe invalidation, and honest partial/outcome-unknown receipts.
   - Expose owner approval, denial, explanation, listing, and revocation controls without putting values in prompts, transport, logs, or persisted policy state.

4. **Observation and reveal boundaries**
   - Mark recipient documents contaminated after private fill and block generic model-facing observation in strict mode.
   - Add registered local transformations and explicit route-bound reveal grants; authentication secrets remain action-only.
   - Keep assessors and MCP/ACP/browser adapters on the same authorization core and metadata-only unless a separate disclosure grant names every plaintext recipient.

5. **Proof and rollout**
   - Add unit and adversarial tests for origin/frame spoofing, stale targets, concurrent one-shot use, mid-batch revocation, restart/expiry, bypass behavior, derived-query limits, redaction, and provider-route changes.
   - Add a synthetic multi-field extension harness proof showing values only at the approved DOM fields and absent from broker/native/model-facing messages, logs, errors, and receipts.
   - Land small green commits, rebase each integration point on `origin/main`, push exact commits to `main`, and record any unproved property as `UNKNOWN`.

## Gates

Stop for credentials, spend, release/signing, production deployment, or external-trust decisions. No real vault secret may enter a fixture, log, transcript, or proof artifact.

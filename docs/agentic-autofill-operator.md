# Elf Vault Agentic Autofill Operator Guide

Elf Vault owns encrypted personal records, unlock, approval, passkeys, and value resolution. Magic Browser owns sessions, DOM inspection, redacted evidence, and guarded submit. Hush remains operator/runtime secrets only. Agents never receive raw personal values.

## Synthetic proof (required before any real data)

From the padloc Grove Tree:

```bash
node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree <mb-tree>
```

Magic Browser's `scripts/synthetic-agentic-autofill-e2e.mjs` is a helper invoked only by that runner. Evidence is written only to `.ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/`. The run must exit 0 and `scripts/check-agentic-autofill-artifacts.mjs` must report no leak-scan violations.

Bootstrap before first observation:

1. Query `privacy-status` with an exact target descriptor.
2. If state is `unknown`, send trusted `autofill-observation-reset`.
3. Require `clean` before classify/plan.

`unknown` and `potentially-private` fail closed for generic observation.

## Approval modes

User-facing mode maps to engine mode:

| User-facing | Engine |
|---|---|
| plan-only | `plan` |
| prompted | `manual` |
| standing-policy | `auto` |
| noninteractive | `dontAsk` |

`bypassPrompts` is internal-only. Hard deny, always-ask, lock, expiry, target mismatch, and high-risk step-up always win. Final submit is a separate grant from fill.

## 1Password / 1PUX migration warnings

A 1PUX import produces a structured loss report. It does **not** migrate:

- passkeys
- attachments
- documents
- history
- sharing
- exact TOTP parameters

Passkey path: re-enroll at the relying party, then prove an Elf Vault assertion. Never claim that 1PUX imported passkeys. Do not rotate, revoke, or remove a working credential during autonomous work.

## Limited real-data pilot (gated)

Do not import Chris's real 1Password export until:

1. The canonical synthetic command above exits 0.
2. Independent code review and spec-conformance review have passed.
3. A human decides which few records to seed (name/address, a couple passwords, a couple passkeys via re-enroll, one or two cards).

Pilot order: synthetic proof → one login → one address/profile → one payment card without storing CVV beyond the transaction → passkey re-enroll at one RP.

## Diagnostics

- Padloc extension native host: `me.ch5.padloc`
- Broker responses are closed `elf.padloc-broker-response.v2`. Unknown keys are rejected. Protocol-v1 is readable only as non-authorizing data.
- Privacy states: `unknown` / `clean` / `potentially-private`. Trusted reset cannot clean a document after private writes.

## Deferred

Screenshot masking, cross-origin iframe recipient grants, model disclosure grants, and extra country-specific schemas stay deferred.

## Proof commands

Padloc `.ch5/proof.yaml` is program proof authority. Required keys:

- `agentic-autofill-core-model`
- `agentic-autofill-1pux-import`
- `agentic-autofill-passkey-contract`
- `agentic-autofill-permission-engine`
- `agentic-autofill-broker`
- `agentic-autofill-privacy-gate`
- `agentic-autofill-contract-fixtures`
- `agentic-autofill-synthetic-e2e`

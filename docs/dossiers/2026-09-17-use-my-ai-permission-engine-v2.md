# Use My AI — Agent Permissions and Secret-Blind Execution

**Design revision:** 0.2 · 17 September 2026  
**Applies to:** Use My AI browser broker, the existing Padloc-based vault extension, optional ELF execution, BB/ACP/MCP adapters, and optional JEV/other semantic assessment.  
**Status:** proposed implementation specification, not an audit or a claim that these controls already exist. All application/tool names below are proposed contracts. This revision extends `use-my-ai-privacy-and-vault-addendum.md`; where its permission, reveal, or revocation semantics are less specific, this revision takes precedence. The earlier detector-selection research is not re-benchmarked here.

## 1. Product decision

Model this as a user-controlled agent permission engine, not an AI proxy with a privacy filter attached.

The agent should usually plan operations over **references to data**, while a trusted executor performs the approved operations on the actual data. Default form filling is vault-to-field, not vault-to-model-to-field. JEV, an alternate classifier, the agent, and the ELF control plane do not need the raw values to map semantic fields or evaluate the requested operation.

Separate five questions:

| Question | Governing mechanism |
|---|---|
| Which AI may run, and with what budget? | Compute grant |
| What data item may be used, and for which operation? | Data/action grant |
| Which recipient may receive an exact or derived value? | Disclosure grant |
| Who decides when an operation needs approval? | Approval mode and standing policy |
| Is this authorization still valid now? | Revocation, lease, and execution-time checks |

**Use is not reveal. Fill is not submit. An approval mode is not a grant. A grant is not a permanent copy of data.**

Claude Code is useful interaction-model prior art: its published documentation distinguishes permission modes, explicit rules, and enforcement by the client rather than the model.[P1][P2] This design borrows that separation; it does not assume Claude Code's rules implement this browser/vault policy automatically.

## 2. Honest privacy guarantees

For the default secret-blind path, the intended guarantee is:

> Vault values are not supplied to the planning model, semantic assessor, agent transcript, broker telemetry, or unnecessary remote components. Only a minimal trusted local execution path receives the approved values to deliver them to the approved destination. We create no additional persistent plaintext store for this workflow.

Do not claim literal zero-copy execution. Filling an ordinary web input creates a plaintext value in browser memory and the destination page. That page may receive it before form submission. Chrome specifically warns that sensitive information passed to content scripts can reach the page.[P3]

Do not claim that revocation retrieves delivered data. It prevents future broker-mediated access. It cannot undo a prior model disclosure, a page receiving a value, or a completed action. Clearing a field afterward is best-effort cleanup, not a retraction guarantee.

The strongest mode also requires controlling all agent observation and execution paths. A broker cannot make the same browser secret-blind while simultaneously granting an agent unrestricted CDP, screenshots, JavaScript evaluation, storage reads, or shell access to browser/vault files.

The trust boundary excludes a compromised OS/browser, malicious privileged extensions, and an attacker controlling the trusted executor itself. Origin checking limits *where* disclosure is authorized; it does not certify the recipient site's scripts or future behavior.

## 3. Approval mode and authority are independent axes

Use a small set of understandable modes. These are our proposed semantics, not literal aliases for all Claude Code behavior.

| Mode | What it does |
|---|---|
| `plan` | Inspect only already-authorized, minimized structure; propose mappings/actions. No vault value use or submission. |
| `manual` | Run explicit standing allows; otherwise ask for each uncovered operation. An `alwaysAsk` rule can require confirmation even where a broad standing allow exists. |
| `auto` | The user delegates defined decisions within a bounded envelope. Policy and an optional approved assessor can select operations without routine prompts. Uncovered authority still requires user approval or denial. |
| `dontAsk` | Execute only operations that already have sufficient authorization; deny rather than pause for missing approvals. |
| `bypassPrompts` | Skip ordinary per-call prompting and optional classification inside a user-selected capability envelope. Keep hard denies, revocation, origin binding, vault unlock requirements, and explicit mandatory-confirmation rules. |

Example: a user can select `bypassPrompts` for “fill these contact fields on this origin for ten minutes” while retaining `modelReveal: deny` and `submit: ask`.

Do not label this “bypass absolutely everything.” If an advanced owner-controlled unrestricted export/debug profile is ever provided, label its weaker guarantees separately, never activate it from page content or an agent argument, and never describe it as secret-blind execution. It is not needed for the standard product.

Changing a harness to its own bypass mode must not change vault permissions. Enforcement lives in the broker/vault executor, outside the model and harness approval UI. Claude Code's current docs likewise distinguish prompting from outer isolation and preserve explicit deny rules in bypass mode.[P2]

## 4. Standing policies versus execution grants

A **standing policy** is a durable user choice such as:

> Allow the selected shipping-address item to be filled into approved shipping fields on this exact origin until I revoke it. Do not reveal the values to models. Ask before submitting.

It is not an everlasting bearer token and contains no plaintext field values.

An **execution grant** is a short-lived authorization for a concrete operation derived from that policy or an explicit one-time approval. It binds the actual caller, recipient, data references, target document and fields, operation, limits, and current policy/revocation revision.

A new document requires a new execution grant, even when a standing site policy permits it without another prompt. A new policy revision, new recipient, changed form meaning, different vault item, or added fields requires re-evaluation.

Child agents, remote runtimes, retries, and delegation receive only subsets of authority. Parent revocation invalidates descendants. A model/provider fallback must be re-evaluated whenever the approved disclosure route changes.

### Permission dimensions

| Dimension | Required detail |
|---|---|
| Principal | User, initiating website, broker session, runtime, and delegated agent identity as applicable |
| Source | Vault/item/field references; no global vault enumeration |
| Operation | Describe permitted metadata, fill, authenticate, approved transform, derive, reveal, submit, or modify |
| Recipient | Exact page origin/frame, named model route, trusted user UI, executor, or specifically authorized external service |
| Target | Actual top-level origin, frame origin, tab/frame/document identity, field references, and relevant action target |
| Representation | Opaque action, derived fact, coarse value, masked value, or exact value |
| Duration | Once, task/session, explicit time limit, or standing policy until revoked |
| Limits | Use count, batch size, budget, allowed transformations, and mandatory confirmations |
| Lifecycle | Policy revision, parent reference, revocation generation, expiry, and current status |

Use exact origins by default, not an implicit wildcard for every subdomain. Treat cross-origin embedded forms as separate recipients. Page URLs, query strings, and paths can contain private data; display and log them selectively.

The caller cannot authenticate itself by supplying an `origin` string. Chrome exposes sender origin, frame, tab, and document information; resolve missing top-level context through trusted browser APIs and refuse ambiguous/opaque origins unless a specific supported flow accounts for them.[P4]

## 5. Permission evaluation

Evaluate each atomic disclosure/action before the irreversible handoff:

```text
Authenticated caller + normalized operation + real browser target
    -> hard denies and vault restrictions
    -> current revocation/lease state
    -> parent/delegation restrictions
    -> exact resource/recipient/representation scope
    -> mandatory confirmation rules
    -> standing allows or bounded auto-delegation decision
    -> concrete execution grant
    -> fresh target and authority recheck
    -> atomic use reservation / idempotency handling
    -> minimal side effect
    -> privacy-safe receipt
```

Missing or contradictory authority means ask or deny, depending on mode. An assessor's “pass” is never proof of user consent. A policy may explicitly delegate an assessment-dependent decision within a fixed field/recipient/operation envelope; the assessor cannot enlarge that envelope.

Do not build a permissive cross-product from independently broad grants. Permission to use an address on site A and permission to reveal a first name to model B must not produce permission to reveal the address to model B.

The policy engine returns structured reason codes, matched rules, and available next actions. Do not ask a model to invent an explanation for a decision after the fact.

## 6. Direct form filling: the default workflow

### A. Inspect structure without reading values

The local executor identifies the specific form/document. The agent may receive authorized field metadata: opaque field references, labels, types, required flags, constraints, and finite choice sets. Existing values, hidden fields, password attributes, unrelated panels, arbitrary HTML, and screenshots are excluded.

Labels and other site-provided metadata remain untrusted content and may themselves contain private data or prompt injection. Minimize and mask as needed before an assessor/model receives them. Do not assume an accessibility tree is inherently safe.

### B. Offer a narrow source selection

The vault or trusted UI selects an approved profile/item. The agent receives only semantic source references needed for this job, such as `shipping.postalCode`. No values, global inventory, or unrelated record-presence information are returned.

An opaque reference is session-bound and unguessable, but its possession alone does not authorize use. The executor checks its current scope and grant every time.

### C. Propose mappings

The agent or JEV can suggest:

```text
form field f_1 -> approved source ref r_given_name
form field f_2 -> approved source ref r_postal_code
```

Neither requires knowing the person's actual name or postal code. Mapping confidence is not authorization to disclose a field.

For ambiguity, use trusted UI or a standing mapping rule rather than retrieving all data and asking the model to choose. Site declarations can suggest types; they cannot reclassify a sensitive field as harmless.

### D. Authorize and fill

Show the user a grouped operation with per-field controls, or apply an existing policy. The disclosure recipient is the website, not the agent. The vault resolves approved references inside the trusted local path and hands just those values to its minimal DOM writer.

Use the existing vault extension's own executor where possible. The AI broker should not become an extra plaintext relay. Native messaging or cross-extension messaging may carry authenticated control messages, but do not route the values through the agent transport.[P5]

A batch fill is not a browser-atomic transaction. Recheck before each field or bounded commit segment, record which disclosures have happened, and stop the rest on revocation. Do not claim rollback if some fields have already received values.

### E. Return a receipt, not the values

```json
{
  "status": "completed",
  "receiptId": "receipt_opaque",
  "filledFieldRefs": ["f_1", "f_2"],
  "modelDisclosure": "none",
  "submittedByExecutor": false
}
```

This receipt reports trusted executor behavior. `submittedByExecutor: false` does **not** assert that the website has made no network request. Filling a field is already a disclosure to the page.

### F. Submit separately

An additional grant controls clicks/submission, acceptance of terms, purchases, and other consequential actions. A standing rule can pre-authorize a narrowly defined submission; it need not always require a new human prompt. Recheck changed targets and arguments.

## 7. The observation problem after filling

A form-fill tool returning no values is necessary but not sufficient. The model might later obtain the same values through a screenshot, page text, an accessibility snapshot, an error message, a redirected URL, a network response, or arbitrary script execution.

After a private fill, treat the document and dependent outputs as potentially containing the data. A hostile page can echo, transform, encode, or distribute it. Masking just the original inputs does not solve that problem.

**Strict secret-blind mode:** stop generic model-facing observations of the recipient document; continue through trusted executor receipts and narrowly defined actions, or hand the interaction to the user. Rich page observations can resume only after a separate authorized disclosure or a trusted, appropriately constrained adapter. Do not promise guaranteed non-disclosure from a generic PII scan of arbitrary page output.

**Assistive mode:** offer minimized/redacted observations with explicit residual-risk labeling; do not market it as equivalent to strict mode.

Approved derived outputs also convey information. `valid`, `matched`, or `authenticated` may reveal a fact without revealing the original value. Define those result schemas and their scope, limit repeated queries, and reject arbitrary expressions that turn a derived-data tool into a secret-extraction oracle.

## 8. A small MCP-compatible tool surface

Use one internal authorization model with browser RPC and optional MCP/ACP adapters. MCP is a transport/interface, not the vault's authorization authority.

| Proposed tool | Input | Model-facing result |
|---|---|---|
| `forms.inspect` | Current authorized document/form reference | Minimized structure and opaque field refs |
| `vault.requestBindings` | Needed semantic fields and task purpose | Only permitted source refs, or pending/denied status |
| `forms.fillFromVault` | Field-to-source refs and allowed transform IDs | Receipt only |
| `vault.authenticate` | Approved target/account refs | Minimal status; no password, token, OTP seed, or private key |
| `vault.derive` | Source refs and registered bounded operation | Approved derived fact or opaque output ref |
| `privacy.requestReveal` | Particular refs, necessary purpose, exact recipient route, duration | Approval request/grant reference, never an automatic plaintext return |
| `context.readApproved` | Valid reveal grant and scoped refs | Only the explicitly approved projection to the bound recipient |
| `forms.submit` | Approved form/action reference | Minimal action receipt |
| `permissions.explain` | Proposed operation | Applicable scoped rules and missing authority, without leaking unrelated vault data |
| `permissions.request` | Requested narrowing/expansion | Trusted consent flow status; no autonomous policy modification |

Owner-facing grant management exposes revoke/list/edit controls. Agents may relinquish their own delegated grants but must not gain owner-wide grant management from this interface.

The model's arguments are proposals. The server re-derives identity and target bindings; it never trusts an agent-supplied `userApproved: true` or arbitrary callback URL.

For real MCP integrations, negotiate the supported spec version. MCP's 2025-11-25 elicitation spec separates non-secret in-band form interactions from out-of-band URL interactions for credentials. It prohibits requesting passwords, API keys, and similar credentials through form elicitation.[P6] Reuse that distinction for supported clients; otherwise a trusted extension UI can handle approval. Do not put vault secrets into elicitation URLs or normal tool results.

A permission prompt must not itself expose the secret to the requesting model. A missing profile field can be entered directly in trusted vault/UI flow, with “use once” separate from “save.”

## 9. Reveal is an explicit declassification operation

Prefer this order:

```text
Reference-only action
  -> local deterministic transformation
  -> approved coarse or derived information
  -> exact personal data revealed to a specific model route
```

Examples of operations that should not require a language model to read raw data: date formatting, choosing an already-specified address component, assembling a full name from selected fields, or filling a stored email. Implement registered transformations, not arbitrary model-authored scripts over the vault.

Free-text work can genuinely require content. An assistant drafting a response from a private note may request the specific paragraph, not the entire note collection. The UI states the actual provider/runtime recipients and the output destination. A classifier is a separate recipient and needs its own permission.

Bind a reveal grant to the particular user/account, workflow, agent session, route revision, selected fields/projection, use count, and expiry. Do not authorize `recipient: any-model`. A route includes every component that must see plaintext: a remote harness or relay is not magically excluded because it is not the final inference provider.

Offer once, this task/session, a timed allowance, or a standing policy until revoked. Standing permission stores authorization metadata, not the value as permanent model memory.

**Once means one authorized delivery, not forced forgetting afterward.** Once plaintext reaches a model request or harness transcript, expiry cannot make that recipient unsee it. On revocation, block further reads and replays, stop reusing contaminated histories in broker-controlled requests, and start a clean scoped session when necessary. Do not claim control over retention already performed by an outside recipient.

Authentication secrets remain action-only in the default profile. Ordinary form filling never needs an LLM to inspect a password or private key. Any owner-directed raw-secret export would be an explicitly weaker advanced path, not a reason to weaken the standard tools.

## 10. Permission UI

Use a matrix users can understand. Example only:

| Data on the selected item | Fill on this origin | Reveal to selected AI route | Ongoing allowance |
|---|---|---|---|
| First name | Allow | Ask | Until revoked |
| Shipping address | Allow | Deny | This task |
| Phone number | Ask | Deny | Once |
| Login credential | Authenticate only | Deny | Until revoked |
| Private free-text note | Ask | Ask for selected passage | Once |

The interface should show the exact top-level and embedded recipient domains, the approved source item without unnecessary identifiers, the operation, the fact that a filled page can access the value, model visibility, submission rights, and duration.

Batch consent reduces interruption, but the grant must still retain per-field boundaries. Provide one-time allow, task allow, persistent scoped policy, deny once, persistent deny, and revoke. Do not let a “remember this” checkbox silently broaden from an item to the whole vault or from a host to all subdomains.

## 11. Revocation: local, remote, and offline

### Authority and transport

A user-authorized control channel can revoke an item-field grant, site policy, task, device, provider disclosure, or all access. Remote control needs only opaque identifiers, policy revisions, and authenticated commands—not vault values.

Use authenticated, replay-resistant revocation events with monotonic revisions. Validate the issuing user's/device's authority. An optional stronger design uses user-held signing keys; the authorization and recovery model must be explicit rather than relying on a page-supplied identity.

The vault executor enforces revocation at the final data-release/action boundary, independently of the agent's connection state. Parent revocation invalidates descendants. Recheck before resolving a reference, writing a field, releasing a tool result, sending a model payload, and retrying an operation.

### Online and offline policy choices

- **Online-required:** obtain current authority immediately before a sensitive release. No connection means no new release. Revocation and authorization need a defined ordering; an already committed handoff is not retractable.
- **Bounded offline lease:** allow operations only until a short, explicit grant lease expires. Renew only against current authoritative state, never indefinitely from a stale local policy cache. Push revocation for fast connected enforcement, with expiry as the partition bound.
- **Local-only profile:** permits local operation without a remote authority, but cannot promise remote revocation while disconnected. The UI must state that difference.

Do not advertise instantaneous global revocation on offline devices. RFC 7009 discusses the same underlying tradeoff for tokens: propagation, online authorization state, and short-lived credentials have different revocation properties.[P7] This protocol must implement its own semantics; issuing a JWT does not solve them.

The UI distinguishes `revocation committed`, `device acknowledged`, and `offline lease pending`. Lease length is a product/security choice, not a measured guarantee in this document. Account for clock uncertainty, suspended devices, restarts, queueing, and in-flight releases. Expired or unverifiable grants fail closed.

### Mid-flight handling

Cancel queued work and stop additional fields; invalidate references; discard unreleased private buffers; stop further model disclosures and transcript replay. A release that already crossed the boundary remains disclosed. Clearing fields or asking a provider to remove retained data is a separate best-effort operation, not permission revocation itself.

One-shot operations need atomic reservation and replay-resistant idempotency. Define statuses including `reserved`, `executing`, `completed`, `partial`, `denied`, `revoked`, and `outcome-unknown`. A timeout does not authorize repeating an irreversible action blindly.

## 12. Proposed internal type sketch

This is a schema sketch, not production enforcement code. Validate runtime inputs and trusted browser context independently.

```ts
type Operation =
  | "describe" | "fill" | "authenticate" | "derive"
  | "reveal" | "submit";

type Recipient =
  | { kind: "page"; topOrigin: string; frameOrigin: string }
  | { kind: "model-route"; routeId: string; routeRevision: number }
  | { kind: "user-ui"; deviceId: string }
  | { kind: "executor"; deviceId: string; executorId: string };

interface ExecutionGrant {
  readonly id: string;
  readonly parentGrantId?: string;
  readonly policyId?: string;
  readonly policyRevision: number;
  readonly revocationGeneration: number;
  readonly principal: {
    userId: string;
    initiatingOrigin: string;
    sessionId: string;
    agentId?: string;
    runtimeId?: string;
  };
  readonly operation: Operation;
  readonly bindings: ReadonlyArray<{
    sourceRef: string;
    sourceVersion?: string;
    fieldRef?: string;
    transformId?: string;
  }>;
  readonly recipient: Recipient;
  readonly target?: {
    tabId: number;
    frameId: number;
    documentId: string;
    formRef: string;
    targetRevision: string;
  };
  readonly representation: "action-only" | "derived" | "coarse" | "exact";
  readonly requestDigest: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly enforcement: {
    localExecutorOnly: boolean;
    allowModelDisclosure: boolean;
    requiresFreshUserConfirmation: boolean;
    revocationMode: "online-required" | "leased" | "local-only";
    leaseExpiresAt?: string;
  };
}
```

The request digest binds normalized action semantics and scoped refs, not an unsalted hash of a low-entropy secret. Authoritative use counters and status live in protected state; a client cannot alter `maxUses` or revive a revoked signed grant. Bind any session token to the authenticated client/channel and enforce all scope server-side.

## 13. JEV and other optional assessors

Give an assessor the authorized goal, sanitized field descriptions, candidate mapping, data categories, target origin, and relevant policy facts. Do not give it raw values just to decide whether those values may be used.

Useful judgments include relevance of a requested field, suspicious mismatches between a task and requested action, unsupported mappings, likely prompt-injection content, and conflicts with the user's stated preferences. TypeSafe's guardrails cookbook explicitly separates scoring from application-owned thresholds and decisions.[P8]

Model-backed approval can choose among already delegated actions; it cannot authorize new recipients or value classes. A failed/unavailable assessment yields `unassessed`, not `safe`. Required checks fail closed or ask; optional checks fall back to the deterministic baseline without pretending an assessment occurred.

Policy evaluation, expiry arithmetic, origin checks, grant consumption, and revocation are deterministic. No classifier sits on the plaintext transfer path in secret-blind mode.

## 14. ELF and harness integration

In the strongest local-first arrangement:

```text
Local or ELF-hosted agent: handles, mappings, action proposals
                         |
                         v
User-device broker: grants and target validation
                         |
                         v
Local Padloc executor: vault resolution -> approved local form
                         |
                         v
Agent receives a permitted receipt, not the values
```

ELF may synchronize policy metadata and carry authenticated proposals. It does not need local vault plaintext. If the browser being filled runs in ELF, the target browser necessarily receives the values in the cloud; that is a distinct explicitly authorized remote-data path, not the local-only guarantee.

A compromised remote agent must not gain an alternate direct connection to the vault or unrestricted observation channel into the local browser. Use the same executor policy for browser RPC, MCP, ACP, and native helper transports. Preserve existing CH5 policy authority; adapters do not invent a second policy owner.

## 15. Minimal implementation sequence

**Slice 1: direct fill plus hard boundaries.** Define scoped references, policy rules, concrete execution grants, trusted source selection, minimal form metadata, the direct vault writer, receipts, and separate submission. Demonstrate a real multi-field form with synthetic data and zero raw values in model or JEV traffic.

**Slice 2: standing permissions and owner controls.** Add per-origin/per-item policy UI, grouped approvals, manual/auto/dontAsk/bypassPrompts modes, authenticated remote revocation, short leases, and lifecycle handling. Do not ship remote revocation claims without offline/race tests.

**Slice 3: optional assessment and reveal.** Add JEV/alternate assessor on authorized metadata; registered transformations; explicit per-recipient reveal; contamination-aware session management; MCP adapters and ELF proposal transport.

Keep no-classifier routing functional throughout. Do not delay direct secret-blind filling for a perfect privacy model or another model leaderboard.

## 16. Release tests

| Scenario | Required outcome |
|---|---|
| Agent fills a name/address form | Only selected values reach approved fields; model sees refs/receipts |
| Agent requests raw values after fill | Separate reveal authority required |
| Page echoes a secret in a label or screenshot | Strict mode prevents generic observation from reaching model |
| Wrong-origin or embedded-frame target | Refuse or require the matching recipient grant |
| Page changes field identity after approval | Revalidate; refuse stale mappings |
| Page sends `approved: true` or fake origin | Ignore claim; use trusted authority and sender context |
| Two concurrent uses of a one-shot grant | At most the authorized release reservation succeeds |
| Fill batch revoked midway | Stop remaining fields; report partial disclosure honestly |
| Remote revocation while device offline | No renewal from stale cache; expiry behavior matches declared mode |
| Restart or restored suspended session | Do not resurrect expired/revoked authority |
| Provider/model/runtime fallback | Re-evaluate disclosure recipients before sending plaintext |
| Harness uses bypass permissions | Vault hard boundaries still apply |
| Assessor approves an out-of-scope request | No expansion of authority |
| Repeated derived queries attempt reconstruction | Enforce registered operations and limits |
| Tool error or timeout includes raw value | Redact/replace before agent, logs, and telemetry |
| Local-only workflow selects cloud browser | Require explicit change of data-location grant |
| Revoked reveal exists in old transcript | Prevent broker-controlled replay; start clean scoped context |

Use synthetic canary values and inspect outbound model/assessor requests, logs, traces, crash paths, screenshots, cached transcripts, and replay behavior. Metadata itself can be sensitive; store only what the user-approved audit function needs. Do not use plaintext originals as routine telemetry or central evaluation input.

## 17. Bottom-line decisions

Build **Claude-Code-style interaction controls over a separate per-item, per-recipient capability system**. The productive default is standing-policy automation, not an approval prompt for every keystroke.

Keep planning separate from handling values. Prefer direct actions over disclosure, references over raw data, and narrowly registered transformations over arbitrary execution on the vault. Make explicit reveal possible where it is genuinely useful, with honest recipient and retention semantics.

Revocation cuts off future authority; it does not retrieve past disclosures. The browser page is a recipient as soon as it receives a value. Those two limits must be reflected in both implementation and product language.

## Verified primary references

[P1] Anthropic, Configure permissions. `https://code.claude.com/docs/en/permissions`

[P2] Anthropic, Choose a permission mode. `https://code.claude.com/docs/en/permission-modes`

[P3] Chrome for Developers, Stay secure. `https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure`

[P4] Chrome runtime API, MessageSender. `https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender`

[P5] Chrome for Developers, Message passing. `https://developer.chrome.com/docs/extensions/develop/concepts/messaging`

[P6] MCP specification 2025-11-25, Elicitation. `https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation`

[P7] IETF RFC 7009, OAuth 2.0 Token Revocation, especially section 2.1 and section 3. `https://www.rfc-editor.org/rfc/rfc7009.html`

[P8] TypeSafe, Guardrails for LLMs. `https://docs.typesafe.ai/cookbooks/llm_guardrails`

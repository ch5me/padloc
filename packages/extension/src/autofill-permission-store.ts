import {
    AgentApprovalMode,
    AgentUserFacingApprovalMode,
    agentReleaseClassForRole,
    isAgentRoleKnown,
    mapUserFacingAgentApprovalMode,
    permissionRequestDigest,
} from "./agent-permission-engine";
import type { PendingBrokerPlan } from "./autofill-broker";

export interface StoredAutofillPolicyBinding {
    itemId: string;
    roles: string[];
}

export interface StoredAutofillPolicy {
    id: string;
    revision: number;
    revocationGeneration: number;
    status: "active" | "revoked";
    effect: "allow" | "deny" | "alwaysAsk";
    topOrigin: string;
    frameOrigin: string;
    bindings: StoredAutofillPolicyBinding[];
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
}

export interface AutofillPermissionState {
    schemaVersion: 1;
    accountId: string;
    mode: AgentApprovalMode;
    revision: number;
    revocationGeneration: number;
    policies: StoredAutofillPolicy[];
}

export interface AutofillPermissionStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
}

export interface AutofillPolicyMatch {
    effect: StoredAutofillPolicy["effect"];
    policy: StoredAutofillPolicy;
}

export interface AutofillAuthorityDecision {
    outcome: "allow" | "ask" | "deny" | "plan";
    reasonCode:
        | "ALLOW_MATCHED_POLICY"
        | "ASK_ALWAYS"
        | "ASK_MISSING_AUTHORITY"
        | "DENY_HARD_POLICY"
        | "DENY_CONFIRMATION_REQUIRED"
        | "DENY_MISSING_AUTHORITY"
        | "DENY_INTERNAL_MODE"
        | "DENY_VAULT_LOCKED"
        | "DENY_ONLINE_AUTHORITY_UNAVAILABLE"
        | "PLAN_ONLY";
    policy?: StoredAutofillPolicy;
}

export interface AutofillAuthorityContext {
    vaultState?: "locked" | "unlocked" | "unknown";
    onlineAuthorityCurrent?: boolean;
    confirmedRequestDigest?: string;
}

const STORAGE_KEY_PREFIX = "pl_agenticAutofillPermissions_v1_";

export class AutofillPermissionRepository {
    constructor(private readonly _storage: AutofillPermissionStorage) {}

    async load(accountId: string): Promise<AutofillPermissionState> {
        const key = storageKey(accountId);
        const stored = (await this._storage.get(key))[key];
        return isAutofillPermissionState(stored, accountId)
            ? cloneState(stored)
            : createAutofillPermissionState(accountId);
    }

    async save(state: AutofillPermissionState): Promise<void> {
        if (!isAutofillPermissionState(state, state.accountId)) throw new Error("Invalid autofill permission state");
        await this._storage.set({ [storageKey(state.accountId)]: cloneState(state) });
    }
}

export function createAutofillPermissionState(accountId: string): AutofillPermissionState {
    if (!accountId) throw new Error("Autofill permission state requires an account id");
    return {
        schemaVersion: 1,
        accountId,
        mode: "manual",
        revision: 0,
        revocationGeneration: 0,
        policies: [],
    };
}

export function setAutofillApprovalMode(
    state: AutofillPermissionState,
    mode: AgentApprovalMode | AgentUserFacingApprovalMode
): AutofillPermissionState {
    const mappedMode = mapStoredApprovalMode(mode);
    if (mappedMode === "bypassPrompts") {
        throw new Error("bypassPrompts is internal-only");
    }
    if (!["plan", "manual", "auto", "dontAsk"].includes(mappedMode)) {
        throw new Error("Unsupported autofill approval mode");
    }
    return { ...cloneState(state), mode: mappedMode, revision: state.revision + 1 };
}

export function addAutofillStandingPolicy(
    state: AutofillPermissionState,
    plan: PendingBrokerPlan,
    effect: StoredAutofillPolicy["effect"],
    policyId: string,
    now = Date.now(),
    expiresAt?: string
): AutofillPermissionState {
    if (!policyId) throw new Error("Autofill policy id is required");
    if (effect !== "allow" && effect !== "deny" && effect !== "alwaysAsk") {
        throw new Error("Unsupported autofill policy effect");
    }
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now)) {
        throw new Error("Autofill policy expiry is invalid");
    }
    const next = cloneState(state);
    const revision = next.revision + 1;
    const timestamp = new Date(now).toISOString();
    const policy: StoredAutofillPolicy = {
        id: policyId,
        revision,
        revocationGeneration: next.revocationGeneration,
        status: "active",
        effect,
        topOrigin: plan.target.topOrigin,
        frameOrigin: plan.target.frameOrigin,
        bindings: normalizePolicyBindings(plan),
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt,
    };
    next.revision = revision;
    next.policies = [...next.policies.filter((candidate) => candidate.id !== policyId), policy];
    return next;
}

export function revokeAutofillPolicy(
    state: AutofillPermissionState,
    policyId: string,
    now = Date.now()
): AutofillPermissionState {
    const policy = state.policies.find((candidate) => candidate.id === policyId);
    if (!policy) throw new Error("Autofill policy not found");
    const next = cloneState(state);
    next.revision += 1;
    next.revocationGeneration += 1;
    next.policies = next.policies.map((candidate) =>
        candidate.id === policyId
            ? {
                  ...candidate,
                  status: "revoked" as const,
                  revision: next.revision,
                  revocationGeneration: next.revocationGeneration,
                  updatedAt: new Date(now).toISOString(),
              }
            : candidate
    );
    return next;
}

export function revokeAllAutofillPolicies(state: AutofillPermissionState, now = Date.now()): AutofillPermissionState {
    const next = cloneState(state);
    next.revision += 1;
    next.revocationGeneration += 1;
    const updatedAt = new Date(now).toISOString();
    next.policies = next.policies.map((policy) => ({
        ...policy,
        status: "revoked" as const,
        revision: next.revision,
        revocationGeneration: next.revocationGeneration,
        updatedAt,
    }));
    return next;
}

export function matchAutofillStandingPolicy(
    state: AutofillPermissionState,
    plan: PendingBrokerPlan,
    now = Date.now()
): AutofillPolicyMatch | null {
    const matches = state.policies
        .filter((policy) => policyMatchesPlan(policy, plan, now))
        .sort((left, right) => right.revision - left.revision);
    const deny = matches.find((policy) => policy.effect === "deny");
    if (deny) return { effect: "deny", policy: deny };
    const alwaysAsk = matches.find((policy) => policy.effect === "alwaysAsk");
    if (alwaysAsk) return { effect: "alwaysAsk", policy: alwaysAsk };
    const allow = matches.find((policy) => policy.effect === "allow");
    return allow ? { effect: "allow", policy: allow } : null;
}

export function decideAutofillPlanAuthority(
    state: AutofillPermissionState,
    plan: PendingBrokerPlan,
    now = Date.now(),
    context: AutofillAuthorityContext = {}
): AutofillAuthorityDecision {
    if (state.mode === "bypassPrompts") return { outcome: "deny", reasonCode: "DENY_INTERNAL_MODE" };
    if (context.vaultState && context.vaultState !== "unlocked") {
        return { outcome: "deny", reasonCode: "DENY_VAULT_LOCKED" };
    }
    if (context.onlineAuthorityCurrent === false) {
        return { outcome: "deny", reasonCode: "DENY_ONLINE_AUTHORITY_UNAVAILABLE" };
    }
    const match = matchAutofillStandingPolicy(state, plan, now);
    if (match?.effect === "deny") return { outcome: "deny", reasonCode: "DENY_HARD_POLICY", policy: match.policy };
    if (state.mode === "plan") return { outcome: "plan", reasonCode: "PLAN_ONLY" };
    if (match?.effect === "alwaysAsk") {
        if (state.mode === "dontAsk") {
            return { outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED", policy: match.policy };
        }
        return { outcome: "ask", reasonCode: "ASK_ALWAYS", policy: match.policy };
    }
    if (match?.effect === "allow") {
        if (planRequiresFreshVerification(plan) && !hasConfirmedPlanDigest(plan, context)) {
            if (state.mode === "dontAsk") {
                return { outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED", policy: match.policy };
            }
            return { outcome: "ask", reasonCode: "ASK_ALWAYS", policy: match.policy };
        }
        return { outcome: "allow", reasonCode: "ALLOW_MATCHED_POLICY", policy: match.policy };
    }
    if (state.mode === "manual" || state.mode === "auto") {
        return { outcome: "ask", reasonCode: "ASK_MISSING_AUTHORITY" };
    }
    return { outcome: "deny", reasonCode: "DENY_MISSING_AUTHORITY" };
}

export function publicAutofillPermissionState(state: AutofillPermissionState) {
    return {
        mode: state.mode === "bypassPrompts" ? "dontAsk" : state.mode,
        revision: state.revision,
        revocationGeneration: state.revocationGeneration,
        policies: state.policies.map((policy) => ({
            id: policy.id,
            revision: policy.revision,
            status: policy.status,
            effect: policy.effect,
            topOrigin: policy.topOrigin,
            frameOrigin: policy.frameOrigin,
            roles: Array.from(new Set(policy.bindings.flatMap((binding) => binding.roles))).sort(),
            itemCount: policy.bindings.length,
            createdAt: policy.createdAt,
            updatedAt: policy.updatedAt,
            expiresAt: policy.expiresAt,
        })),
    };
}

export function isAutofillPermissionState(value: unknown, accountId: string): value is AutofillPermissionState {
    if (!value || typeof value !== "object") return false;
    const candidate = value as AutofillPermissionState;
    if (
        candidate.schemaVersion !== 1 ||
        candidate.accountId !== accountId ||
        !["plan", "manual", "auto", "dontAsk"].includes(candidate.mode) ||
        !Number.isInteger(candidate.revision) ||
        candidate.revision < 0 ||
        !Number.isInteger(candidate.revocationGeneration) ||
        candidate.revocationGeneration < 0 ||
        !Array.isArray(candidate.policies)
    ) {
        return false;
    }
    return candidate.policies.every(isStoredPolicy);
}

function policyMatchesPlan(policy: StoredAutofillPolicy, plan: PendingBrokerPlan, now: number): boolean {
    if (policy.status !== "active") return false;
    if (policy.expiresAt && Date.parse(policy.expiresAt) <= now) return false;
    if (policy.topOrigin !== plan.target.topOrigin || policy.frameOrigin !== plan.target.frameOrigin) return false;
    if (
        plan.fields.some(
            (field) =>
                !isAgentRoleKnown(field.role) &&
                field.role !== "passkey" &&
                !field.role.startsWith("passkey.")
        )
    ) {
        return false;
    }
    return plan.fields.every((field) =>
        policy.bindings.some((binding) => binding.itemId === field.itemId && binding.roles.includes(field.role))
    );
}

function planRequiresFreshVerification(plan: PendingBrokerPlan): boolean {
    return plan.fields.some((field) => {
        const roleClass = agentReleaseClassForRole(field.role);
        return (
            field.transactionOnly ||
            (field as PendingBrokerPlan["fields"][number] & { releaseClass?: string }).releaseClass === "high-risk" ||
            roleClass === "high-risk" ||
            field.role === "passkey" ||
            field.role.startsWith("passkey.") ||
            plan.permissionRequest.passkey === true ||
            plan.permissionRequest.isPasskey === true ||
            plan.permissionRequest.newPaymentOrigin === true ||
            plan.permissionRequest.isNewPaymentOrigin === true ||
            plan.permissionRequest.policyChange === true ||
            plan.permissionRequest.isPolicyChange === true ||
            plan.permissionRequest.securityContext?.passkey === true ||
            plan.permissionRequest.securityContext?.isPasskey === true ||
            plan.permissionRequest.securityContext?.newPaymentOrigin === true ||
            plan.permissionRequest.securityContext?.isNewPaymentOrigin === true ||
            plan.permissionRequest.securityContext?.policyChange === true ||
            plan.permissionRequest.securityContext?.isPolicyChange === true
        );
    });
}

function hasConfirmedPlanDigest(plan: PendingBrokerPlan, context: AutofillAuthorityContext): boolean {
    const expected = context.confirmedRequestDigest;
    if (!expected) return false;
    return expected === permissionRequestDigest(plan.permissionRequest);
}

function mapStoredApprovalMode(mode: AgentApprovalMode | AgentUserFacingApprovalMode): AgentApprovalMode {
    if (
        mode === "plan-only" ||
        mode === "prompted" ||
        mode === "standing-policy-automatic" ||
        mode === "standing-policy automatic" ||
        mode === "noninteractive" ||
        mode === "noninteractive fail-closed" ||
        mode === "noninteractive-fail-closed"
    ) {
        return mapUserFacingAgentApprovalMode(mode);
    }
    return mode;
}

function normalizePolicyBindings(plan: PendingBrokerPlan): StoredAutofillPolicyBinding[] {
    const rolesByItem = new Map<string, Set<string>>();
    for (const field of plan.fields) {
        const roles = rolesByItem.get(field.itemId) || new Set<string>();
        roles.add(field.role);
        rolesByItem.set(field.itemId, roles);
    }
    return Array.from(rolesByItem.entries())
        .map(([itemId, roles]) => ({ itemId, roles: Array.from(roles).sort() }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function isStoredPolicy(value: unknown): value is StoredAutofillPolicy {
    if (!value || typeof value !== "object") return false;
    const policy = value as StoredAutofillPolicy;
    return Boolean(
        policy.id &&
            Number.isInteger(policy.revision) &&
            policy.revision >= 0 &&
            Number.isInteger(policy.revocationGeneration) &&
            policy.revocationGeneration >= 0 &&
            ["active", "revoked"].includes(policy.status) &&
            ["allow", "deny", "alwaysAsk"].includes(policy.effect) &&
            isExactHttpOrigin(policy.topOrigin) &&
            isExactHttpOrigin(policy.frameOrigin) &&
            Array.isArray(policy.bindings) &&
            policy.bindings.every(
                (binding) => binding && binding.itemId && Array.isArray(binding.roles) && binding.roles.length > 0
            ) &&
            Number.isFinite(Date.parse(policy.createdAt)) &&
            Number.isFinite(Date.parse(policy.updatedAt)) &&
            (!policy.expiresAt || Number.isFinite(Date.parse(policy.expiresAt)))
    );
}

function isExactHttpOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return url.origin === value && url.origin !== "null" && (url.protocol === "https:" || url.protocol === "http:");
    } catch {
        return false;
    }
}

function storageKey(accountId: string): string {
    return `${STORAGE_KEY_PREFIX}${accountId}`;
}

function cloneState(state: AutofillPermissionState): AutofillPermissionState {
    return JSON.parse(JSON.stringify(state)) as AutofillPermissionState;
}

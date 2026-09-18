import { expect } from "chai";
import {
    AutofillPermissionRepository,
    addAutofillStandingPolicy,
    createAutofillPermissionState,
    isAutofillPermissionState,
    matchAutofillStandingPolicy,
    publicAutofillPermissionState,
    revokeAllAutofillPolicies,
    revokeAutofillPolicy,
    setAutofillApprovalMode,
} from "../src/autofill-permission-store";

suite("Autofill permission store", () => {
    test("stores only scoped authorization metadata", () => {
        const state = addAutofillStandingPolicy(
            createAutofillPermissionState("account-1"),
            plan(),
            "allow",
            "policy-1",
            now
        );
        const serialized = JSON.stringify(state);
        expect(serialized).to.contain("item-person");
        expect(serialized).to.contain("contact.email");
        expect(serialized).not.to.contain("sentinel@example.test");
        expect(serialized).not.to.contain("source-ref");
        expect(serialized).not.to.contain("field-ref");
    });

    test("matches exact origins, items, and roles without broadening the cross product", () => {
        const state = addAutofillStandingPolicy(
            createAutofillPermissionState("account-1"),
            plan(),
            "allow",
            "policy-1",
            now
        );
        expect(matchAutofillStandingPolicy(state, plan(), now)?.effect).to.equal("allow");
        expect(matchAutofillStandingPolicy(state, plan({ topOrigin: "https://evil.example" }), now)).to.equal(null);
        expect(matchAutofillStandingPolicy(state, plan({ itemId: "item-other" }), now)).to.equal(null);
        expect(matchAutofillStandingPolicy(state, plan({ role: "contact.phone" }), now)).to.equal(null);
    });

    test("gives deny and always-ask policies precedence over allow", () => {
        let state = createAutofillPermissionState("account-1");
        state = addAutofillStandingPolicy(state, plan(), "allow", "allow", now);
        state = addAutofillStandingPolicy(state, plan(), "alwaysAsk", "ask", now + 1);
        expect(matchAutofillStandingPolicy(state, plan(), now + 2)?.effect).to.equal("alwaysAsk");
        state = addAutofillStandingPolicy(state, plan(), "deny", "deny", now + 3);
        expect(matchAutofillStandingPolicy(state, plan(), now + 4)?.effect).to.equal("deny");
    });

    test("increments monotonic revisions and revocation generations", () => {
        let state = addAutofillStandingPolicy(
            createAutofillPermissionState("account-1"),
            plan(),
            "allow",
            "policy-1",
            now
        );
        const initialRevision = state.revision;
        state = setAutofillApprovalMode(state, "dontAsk");
        expect(state.revision).to.equal(initialRevision + 1);
        state = revokeAutofillPolicy(state, "policy-1", now + 1);
        expect(state.revocationGeneration).to.equal(1);
        expect(state.policies[0].status).to.equal("revoked");
        state = revokeAllAutofillPolicies(state, now + 2);
        expect(state.revocationGeneration).to.equal(2);
    });

    test("fails closed on corrupt or cross-account persisted state", async () => {
        const storage = new MemoryStorage({ pl_agenticAutofillPermissions_v1_account1: { schemaVersion: 1 } });
        const repository = new AutofillPermissionRepository(storage);
        const loaded = await repository.load("account1");
        expect(loaded).to.deep.equal(createAutofillPermissionState("account1"));
        expect(isAutofillPermissionState({ ...loaded, accountId: "account2" }, "account1")).to.equal(false);
    });

    test("returns owner-facing policy metadata without item identifiers", () => {
        const state = addAutofillStandingPolicy(
            createAutofillPermissionState("account-1"),
            plan(),
            "allow",
            "policy-1",
            now
        );
        const visible = publicAutofillPermissionState(state);
        expect(visible.policies[0].itemCount).to.equal(1);
        expect(visible.policies[0].roles).to.deep.equal(["contact.email"]);
        expect(JSON.stringify(visible)).not.to.contain("item-person");
    });
});

const now = Date.parse("2026-09-18T12:00:00.000Z");

function plan(overrides: { topOrigin?: string; itemId?: string; role?: string } = {}) {
    const topOrigin = overrides.topOrigin || "https://shop.example";
    const role = overrides.role || "contact.email";
    return {
        planId: "plan-1",
        request: { type: "plan-fill", protocolVersion: 1, binding: { sessionId: "session-1", origin: topOrigin } },
        target: {
            tabId: 42,
            frameId: 0,
            documentId: "document-1",
            formRef: "form-1",
            targetRevision: "revision-1",
            topOrigin,
            frameOrigin: topOrigin,
        },
        fields: [
            {
                selector: "#email",
                role,
                fieldRef: "field-ref",
                sourceRef: "source-ref",
                itemId: overrides.itemId || "item-person",
                itemName: "Synthetic Person",
                fieldIndex: 0,
                fieldName: "Email",
                valuePreview: "stored",
                transactionOnly: false,
                dataClass: "profile",
            },
        ],
        permissionRequest: {} as never,
        createdAt: now,
    } as any;
}

class MemoryStorage {
    constructor(private readonly values: Record<string, unknown> = {}) {}

    async get(key: string) {
        return { [key]: this.values[key] };
    }

    async set(value: Record<string, unknown>) {
        Object.assign(this.values, value);
    }
}

import { expect } from "chai";
import { AutofillObservationLedger } from "../src/autofill-observation-policy";

suite("Autofill observation policy", () => {
    test("marks a document potentially private before any generic observation", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        await ledger.markPotentiallyPrivate(target, "field-email", now);
        const status = await ledger.status(42, 0, "document-1");
        expect(status).to.include({ state: "potentially-private", genericObservation: "blocked" });
        expect(status.contaminatedAt).to.equal("2026-09-18T12:00:00.000Z");
    });

    test("persists only target metadata and opaque field references across worker restarts", async () => {
        const storage = new MemoryStorage();
        await new AutofillObservationLedger(storage).markPotentiallyPrivate(target, "field-email", now);
        const restored = new AutofillObservationLedger(storage);
        expect(await restored.status(42, 0, "document-1")).to.include({ genericObservation: "blocked" });
        const serialized = JSON.stringify(storage.values);
        expect(serialized).to.contain("field-email");
        expect(serialized).not.to.contain("sentinel@example.test");
    });

    test("returns unknown rather than claiming clean when no trusted proof exists", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        expect(await ledger.status(42, 0, "document-unknown")).to.include({
            state: "unknown",
            genericObservation: "requires-separate-disclosure",
        });
    });

    test("clears stale document metadata when its browser tab closes", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        await ledger.markPotentiallyPrivate(target, "field-email", now);
        await ledger.clearTab(42);
        expect(await ledger.status(42, 0, "document-1")).to.include({ state: "unknown" });
    });

    test("trusted reset creates clean state, then private writes are irreversible", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        const clean = await ledger.reset(target, target);
        expect(clean).to.include({ state: "clean", genericObservation: "allowed", observationRevision: 1 });
        await ledger.markPotentiallyPrivate(target, "field-email", now);
        expect(await ledger.status(target)).to.include({
            state: "potentially-private",
            genericObservation: "blocked",
            observationRevision: 2,
        });
        let rejected = false;
        try {
            await ledger.reset(target, target);
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
    });

    test("rejects a reset for a stale form or target revision", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        await ledger.reset(target, target);
        let rejected = false;
        try {
            await ledger.reset({ ...target, targetRevision: "stale-revision" }, target);
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
    });

    test("rejects a reset when the caller invents a document identity", async () => {
        const ledger = new AutofillObservationLedger(new MemoryStorage());
        let rejected = false;
        try {
            await ledger.reset({ ...target, documentId: "invented-document" }, target);
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
    });
});

const now = Date.parse("2026-09-18T12:00:00.000Z");
const target = {
    tabId: 42,
    frameId: 0,
    origin: "https://shop.example",
    documentId: "document-1",
    formRef: "form-1",
    targetRevision: "revision-1",
    sessionId: "session-1",
    topOrigin: "https://shop.example",
    frameOrigin: "https://shop.example",
};

class MemoryStorage {
    values: Record<string, unknown> = {};

    async get(key: string) {
        return { [key]: this.values[key] };
    }

    async set(value: Record<string, unknown>) {
        Object.assign(this.values, value);
    }
}

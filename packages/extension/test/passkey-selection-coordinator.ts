import { expect } from "chai";
import {
    PasskeySelectionCoordinator,
    PasskeySelectionResolution,
    VerifiedPasskeySelectionMetadata,
} from "../src/passkey-selection-coordinator";

const UI_URL = "chrome-extension://abcdefghijklmnop/popup.html";
const OTHER_UI_URL = "chrome-extension://abcdefghijklmnop/options.html";
const NONCE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function candidates(count = 5) {
    return Array.from({ length: count }, (_, index) => ({
        selectionId: String(index),
        userName: `account-${index + 1}@example.test`,
        userDisplayName: `Account ${index + 1}`,
    }));
}

function metadata(overrides: Partial<VerifiedPasskeySelectionMetadata> = {}): VerifiedPasskeySelectionMetadata {
    return {
        requestId: "ceremony-1",
        origin: "https://accounts.google.com",
        rpId: "google.com",
        candidates: candidates(),
        ...overrides,
    };
}

function scheduler() {
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    const cancelled: unknown[] = [];
    return {
        callbacks,
        delays,
        cancelled,
        schedule(callback: () => void, delayMs: number) {
            callbacks.push(callback);
            delays.push(delayMs);
            return callback;
        },
        cancelScheduled(handle: unknown) {
            cancelled.push(handle);
        },
    };
}

suite("Passkey selection coordinator", () => {
    test("exposes only copied, redacted candidates to the exact bound UI", () => {
        const inputCandidates = candidates();
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: `${UI_URL}#configured-fragment`,
            nonceFactory: () => NONCE,
        });
        const unsafeInput = {
            ...metadata({ candidates: inputCandidates }),
            challenge: "do-not-copy",
            credentialId: "do-not-copy",
            privateKey: "do-not-copy",
        } as VerifiedPasskeySelectionMetadata;
        coordinator.begin(unsafeInput, () => undefined);

        inputCandidates[0].userName = "mutated@example.test";
        inputCandidates.push({ selectionId: "new", userName: "new@example.test", userDisplayName: "New" });
        expect(coordinator.getPrompt(OTHER_UI_URL)).to.equal(null);
        expect(coordinator.getPrompt("https://accounts.google.com/popup.html")).to.equal(null);
        expect(coordinator.getPrompt("not a URL")).to.equal(null);
        const prompt = coordinator.getPrompt(`${UI_URL}#selection`)!;
        expect(prompt.candidates).to.have.length(5);
        expect(prompt.candidates[0].userName).to.equal("account-1@example.test");
        expect(prompt).not.to.have.any.keys("challenge", "credentialId", "privateKey", "options");
        expect(JSON.stringify(prompt)).not.to.include("do-not-copy");
        expect(Object.isFrozen(prompt)).to.equal(true);
        expect(Object.isFrozen(prompt.candidates)).to.equal(true);
        expect(Object.isFrozen(prompt.candidates[0])).to.equal(true);
        coordinator.dispose();
    });

    test("binds selection to request, sender, nonce, and the original candidate set", () => {
        const resolutions: PasskeySelectionResolution[] = [];
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => NONCE,
        });
        coordinator.begin(metadata(), (resolution) => resolutions.push(resolution));

        expect(coordinator.select({ requestId: "other", promptNonce: NONCE, selectionId: "3" }, UI_URL)).to.equal(
            false
        );
        expect(
            coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "3" }, OTHER_UI_URL)
        ).to.equal(false);
        expect(
            coordinator.select({ requestId: "ceremony-1", promptNonce: `${NONCE}x`, selectionId: "3" }, UI_URL)
        ).to.equal(false);
        expect(
            coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "unknown" }, UI_URL)
        ).to.equal(false);
        expect(coordinator.pendingCount).to.equal(1);
        expect(coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "3" }, UI_URL)).to.equal(
            true
        );
        expect(resolutions).to.deep.equal([{ requestId: "ceremony-1", outcome: "selected", selectionId: "3" }]);
        expect(coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "2" }, UI_URL)).to.equal(
            false
        );
    });

    test("consumes selection and dismissal capabilities before replying", () => {
        const resolutions: PasskeySelectionResolution[] = [];
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => NONCE,
        });
        coordinator.begin(metadata(), (resolution) => {
            resolutions.push(resolution);
            expect(
                coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "0" }, UI_URL)
            ).to.equal(false);
            expect(coordinator.dismiss({ requestId: "ceremony-1", promptNonce: NONCE }, UI_URL)).to.equal(false);
            expect(coordinator.cancel("ceremony-1")).to.equal(false);
        });
        expect(coordinator.dismiss({ requestId: "ceremony-1", promptNonce: `${NONCE}x` }, UI_URL)).to.equal(false);
        expect(coordinator.dismiss({ requestId: "ceremony-1", promptNonce: NONCE }, OTHER_UI_URL)).to.equal(false);
        expect(coordinator.dismiss({ requestId: "ceremony-1", promptNonce: NONCE }, UI_URL)).to.equal(true);
        expect(coordinator.dismiss({ requestId: "ceremony-1", promptNonce: NONCE }, UI_URL)).to.equal(false);
        expect(resolutions).to.deep.equal([{ requestId: "ceremony-1", outcome: "dismissed" }]);
    });

    test("uses the injected clock and scheduler to expire exactly once at the deadline", () => {
        let now = 10_000;
        const scheduled = scheduler();
        const resolutions: PasskeySelectionResolution[] = [];
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            ttlMs: 2_000,
            now: () => now,
            nonceFactory: () => NONCE,
            schedule: scheduled.schedule,
            cancelScheduled: scheduled.cancelScheduled,
        });
        coordinator.begin(metadata(), (resolution) => resolutions.push(resolution));
        expect(coordinator.getPrompt(UI_URL)!.expiresAt).to.equal(12_000);
        expect(scheduled.delays).to.deep.equal([2_000]);

        now = 11_999;
        scheduled.callbacks[0]();
        expect(scheduled.delays).to.deep.equal([2_000, 1]);
        expect(resolutions).to.deep.equal([]);
        now = 12_000;
        scheduled.callbacks[1]();
        scheduled.callbacks[0]();
        expect(resolutions).to.deep.equal([{ requestId: "ceremony-1", outcome: "expired" }]);
        expect(coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "0" }, UI_URL)).to.equal(
            false
        );
        expect(scheduled.cancelled).to.have.length(1);
    });

    test("cancels individual and disposed requests exactly once", () => {
        let nonce = 0;
        const scheduled = scheduler();
        const resolutions: PasskeySelectionResolution[] = [];
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => `${String(++nonce).padStart(32, "0")}`,
            schedule: scheduled.schedule,
            cancelScheduled: scheduled.cancelScheduled,
        });
        coordinator.begin(metadata({ requestId: "one" }), (resolution) => resolutions.push(resolution));
        coordinator.begin(metadata({ requestId: "two" }), (resolution) => resolutions.push(resolution));
        expect(coordinator.cancel("missing")).to.equal(false);
        expect(coordinator.cancel("one")).to.equal(true);
        expect(coordinator.cancel("one")).to.equal(false);
        coordinator.dispose();
        coordinator.dispose();
        scheduled.callbacks.forEach((callback) => callback());
        expect(resolutions).to.deep.equal([
            { requestId: "one", outcome: "cancelled" },
            { requestId: "two", outcome: "cancelled" },
        ]);
        expect(scheduled.cancelled).to.have.length(2);
        expect(coordinator.pendingCount).to.equal(0);
    });

    test("bounds lifetime and pending capacity and rejects duplicate request IDs", () => {
        expect(() => new PasskeySelectionCoordinator({ selectionUiSenderUrl: UI_URL, ttlMs: 999 })).to.throw(
            RangeError
        );
        expect(() => new PasskeySelectionCoordinator({ selectionUiSenderUrl: UI_URL, ttlMs: 120_001 })).to.throw(
            RangeError
        );
        expect(() => new PasskeySelectionCoordinator({ selectionUiSenderUrl: UI_URL, maxPending: 0 })).to.throw(
            RangeError
        );
        expect(() => new PasskeySelectionCoordinator({ selectionUiSenderUrl: UI_URL, maxPending: 65 })).to.throw(
            RangeError
        );

        let nonce = 0;
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            maxPending: 1,
            nonceFactory: () => `${String(++nonce).padStart(32, "0")}`,
        });
        coordinator.begin(metadata(), () => undefined);
        expect(() => coordinator.begin(metadata(), () => undefined)).to.throw("already pending");
        expect(() => coordinator.begin(metadata({ requestId: "ceremony-2" }), () => undefined)).to.throw("Too many");
        coordinator.dispose();
    });

    test("accepts exact metadata bounds and rejects values outside every bound", () => {
        let nonce = 0;
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => `${String(++nonce).padStart(32, "0")}`,
        });
        coordinator.begin(
            metadata({
                requestId: "r".repeat(128),
                origin: "https://accounts.google.com",
                rpId: "r".repeat(253),
                candidates: [
                    { selectionId: "s".repeat(128), userName: "u".repeat(256), userDisplayName: "d".repeat(256) },
                    ...candidates(63).map((candidate, index) => ({ ...candidate, selectionId: `id-${index}` })),
                ],
            }),
            () => undefined
        );
        coordinator.dispose();

        const rejects = [
            metadata({ requestId: "" }),
            metadata({ requestId: "r".repeat(129) }),
            metadata({ origin: "https://accounts.google.com/path" }),
            metadata({ origin: "not-an-origin" }),
            metadata({ rpId: "google.com/path" }),
            metadata({ rpId: "r".repeat(254) }),
            metadata({ candidates: candidates(1) }),
            metadata({ candidates: candidates(65) }),
            metadata({ candidates: [{ ...candidates(2)[0] }, { ...candidates(2)[1], selectionId: "0" }] }),
            metadata({ candidates: [{ ...candidates(2)[0], selectionId: "" }, candidates(2)[1]] }),
            metadata({ candidates: [{ ...candidates(2)[0], userName: "unsafe\nlabel" }, candidates(2)[1]] }),
            metadata({ candidates: [{ ...candidates(2)[0], userDisplayName: "d".repeat(257) }, candidates(2)[1]] }),
        ];
        for (const invalid of rejects) expect(() => coordinator.begin(invalid, () => undefined)).to.throw(TypeError);
    });

    test("rejects invalid UI URLs, weak nonces, and missing reply callbacks", () => {
        for (const senderUrl of ["https://example.test/popup.html", "not a URL"]) {
            expect(() => new PasskeySelectionCoordinator({ selectionUiSenderUrl: senderUrl })).to.throw(TypeError);
        }
        const weakNonce = new PasskeySelectionCoordinator({ selectionUiSenderUrl: UI_URL, nonceFactory: () => "weak" });
        expect(() => weakNonce.begin(metadata(), () => undefined)).to.throw("at least 128 bits");
        const invalidNonce = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => `${NONCE}!`,
        });
        expect(() => invalidNonce.begin(metadata(), () => undefined)).to.throw("base64url");
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => NONCE,
        });
        expect(() => coordinator.begin(metadata(), undefined as any)).to.throw("reply callback");
    });
});

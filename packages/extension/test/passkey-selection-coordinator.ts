import { expect } from "chai";
import { PasskeySelectionCoordinator, PasskeySelectionResolution } from "../src/passkey-selection-coordinator";

const UI_URL = "chrome-extension://abcdefghijklmnop/popup.html";
const NONCE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function candidates(count = 5) {
    return Array.from({ length: count }, (_, index) => ({
        selectionId: String(index),
        userName: `account-${index + 1}@example.test`,
        userDisplayName: `Account ${index + 1}`,
    }));
}

suite("Passkey selection coordinator", () => {
    test("binds five redacted candidates to the exact UI, nonce, and one-time selection", () => {
        let resolution: Readonly<PasskeySelectionResolution> | undefined;
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => NONCE,
        });
        coordinator.begin(
            {
                requestId: "ceremony-1",
                origin: "https://accounts.google.com",
                rpId: "google.com",
                candidates: candidates(),
            },
            (value) => (resolution = value)
        );

        expect(coordinator.getPrompt("chrome-extension://other/popup.html")).to.equal(null);
        const prompt = coordinator.getPrompt(`${UI_URL}#selection`)!;
        expect(prompt.candidates).to.have.length(5);
        expect(JSON.stringify(prompt)).not.to.contain("credentialId");
        expect(JSON.stringify(prompt)).not.to.contain("privateKey");
        expect(
            coordinator.select({ requestId: "ceremony-1", promptNonce: `${NONCE}x`, selectionId: "3" }, UI_URL)
        ).to.equal(false);
        expect(
            coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "unknown" }, UI_URL)
        ).to.equal(false);
        expect(coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "3" }, UI_URL)).to.equal(
            true
        );
        expect(resolution).to.deep.equal({ requestId: "ceremony-1", outcome: "selected", selectionId: "3" });
        expect(coordinator.select({ requestId: "ceremony-1", promptNonce: NONCE, selectionId: "2" }, UI_URL)).to.equal(
            false
        );
    });

    test("dismisses, expires, and internally cancels without selecting a credential", () => {
        let now = 1_000;
        const resolutions: PasskeySelectionResolution[] = [];
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            ttlMs: 1_000,
            now: () => now,
            nonceFactory: () => NONCE,
            schedule: () => 1,
            cancelScheduled: () => undefined,
        });
        const begin = (requestId: string) =>
            coordinator.begin(
                { requestId, origin: "https://accounts.google.com", rpId: "google.com", candidates: candidates(2) },
                (resolution) => resolutions.push(resolution)
            );

        begin("dismissed");
        expect(coordinator.dismiss({ requestId: "dismissed", promptNonce: NONCE }, UI_URL)).to.equal(true);
        begin("cancelled");
        expect(coordinator.cancel("cancelled")).to.equal(true);
        begin("expired");
        now = 2_000;
        expect(coordinator.expirePending()).to.equal(1);
        expect(resolutions.map((resolution) => resolution.outcome)).to.deep.equal([
            "dismissed",
            "cancelled",
            "expired",
        ]);
    });

    test("rejects malformed, duplicate, ambiguous, and over-capacity candidate state", () => {
        const coordinator = new PasskeySelectionCoordinator({
            selectionUiSenderUrl: UI_URL,
            nonceFactory: () => NONCE,
        });
        const begin = (candidateList: ReturnType<typeof candidates>) =>
            coordinator.begin(
                {
                    requestId: `request-${candidateList.length}`,
                    origin: "https://accounts.google.com",
                    rpId: "google.com",
                    candidates: candidateList,
                },
                () => undefined
            );
        expect(() => begin(candidates(1))).to.throw(TypeError);
        expect(() => begin([{ ...candidates(2)[0] }, { ...candidates(2)[1], selectionId: "0" }])).to.throw("Duplicate");
        expect(() => begin(candidates(65))).to.throw(TypeError);
        expect(() => begin([{ ...candidates(2)[0], userName: "unsafe\nlabel" }, candidates(2)[1]])).to.throw(TypeError);
    });
});

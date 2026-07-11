import { expect } from "chai";
import {
    PasskeyApprovalCoordinator,
    PasskeyApprovalResolution,
    VerifiedPasskeyApprovalMetadata,
} from "../src/passkey-approval-coordinator";

const UI_URL = "chrome-extension://padloc-test-extension/popup.html";
const OTHER_UI_URL = "chrome-extension://padloc-test-extension/options.html";
const NONCE = "0123456789abcdef0123456789abcdef";

function metadata(overrides: Partial<VerifiedPasskeyApprovalMetadata> = {}): VerifiedPasskeyApprovalMetadata {
    return {
        requestId: "request-1",
        operation: "create",
        origin: "https://accounts.example",
        rpId: "accounts.example",
        rpName: "Example Accounts",
        userName: "person@example.test",
        userDisplayName: "Example Person",
        ...overrides,
    };
}

suite("Passkey approval coordinator", () => {
    test("issues only redacted metadata to the exact extension approval document", () => {
        const resolutions: PasskeyApprovalResolution[] = [];
        const coordinator = new PasskeyApprovalCoordinator({
            approvalUiSenderUrl: `${UI_URL}#approval`,
            nonceFactory: () => NONCE,
        });
        const unsafeInput = {
            ...metadata(),
            challenge: "do-not-copy",
            credentialId: "do-not-copy",
            privateKey: "do-not-copy",
        } as VerifiedPasskeyApprovalMetadata;

        const handle = coordinator.begin(unsafeInput, (resolution) => resolutions.push(resolution));
        const prompt = coordinator.getPrompt(UI_URL);

        expect(handle).to.have.keys(["requestId", "expiresAt"]);
        expect(handle).not.to.have.property("promptNonce");
        expect(coordinator.getPrompt(OTHER_UI_URL)).to.equal(null);
        expect(coordinator.getPrompt("https://accounts.example/popup.html")).to.equal(null);
        expect(prompt).to.deep.include({
            requestId: "request-1",
            promptNonce: NONCE,
            operation: "create",
            origin: "https://accounts.example",
            rpId: "accounts.example",
            rpName: "Example Accounts",
            userName: "person@example.test",
            userDisplayName: "Example Person",
        });
        expect(prompt).not.to.have.any.keys("challenge", "credentialId", "privateKey", "options");
        expect(JSON.stringify(prompt)).not.to.include("do-not-copy");
        expect(resolutions).to.deep.equal([]);
        coordinator.dispose();
    });

    test("requires the bound sender, one-time nonce, and fresh user verification", () => {
        const resolutions: PasskeyApprovalResolution[] = [];
        const coordinator = new PasskeyApprovalCoordinator({ approvalUiSenderUrl: UI_URL, nonceFactory: () => NONCE });
        coordinator.begin(metadata(), (resolution) => {
            resolutions.push(resolution);
            // A callback cannot re-enter and consume the same capability again.
            expect(
                coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: true }, UI_URL)
            ).to.equal(false);
        });

        expect(
            coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: true }, OTHER_UI_URL)
        ).to.equal(false);
        expect(
            coordinator.approve(
                { requestId: "request-1", promptNonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", userVerified: true },
                UI_URL
            )
        ).to.equal(false);
        expect(
            coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: false } as any, UI_URL)
        ).to.equal(false);
        expect(
            coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: true }, UI_URL)
        ).to.equal(true);
        expect(
            coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: true }, UI_URL)
        ).to.equal(false);
        expect(resolutions).to.deep.equal([{ requestId: "request-1", outcome: "approved", userVerified: true }]);
        expect(coordinator.pendingCount).to.equal(0);
    });

    test("capability-checks dismiss and completes it exactly once", () => {
        const resolutions: PasskeyApprovalResolution[] = [];
        const coordinator = new PasskeyApprovalCoordinator({ approvalUiSenderUrl: UI_URL, nonceFactory: () => NONCE });
        coordinator.begin(metadata({ operation: "get" }), (resolution) => resolutions.push(resolution));

        expect(
            coordinator.dismiss({ requestId: "request-1", promptNonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, UI_URL)
        ).to.equal(false);
        expect(coordinator.dismiss({ requestId: "request-1", promptNonce: NONCE }, UI_URL)).to.equal(true);
        expect(coordinator.dismiss({ requestId: "request-1", promptNonce: NONCE }, UI_URL)).to.equal(false);
        expect(resolutions).to.deep.equal([{ requestId: "request-1", outcome: "dismissed" }]);
    });

    test("expires at a bounded deadline and rejects late approval", () => {
        let now = 10_000;
        let scheduled: (() => void) | undefined;
        const scheduledDelays: number[] = [];
        const resolutions: PasskeyApprovalResolution[] = [];
        const coordinator = new PasskeyApprovalCoordinator({
            approvalUiSenderUrl: UI_URL,
            ttlMs: 2_000,
            now: () => now,
            nonceFactory: () => NONCE,
            schedule(callback, delayMs) {
                scheduledDelays.push(delayMs);
                scheduled = callback;
                return callback;
            },
            cancelScheduled() {},
        });
        coordinator.begin(metadata(), (resolution) => resolutions.push(resolution));

        now = 11_999;
        scheduled!();
        expect(scheduledDelays).to.deep.equal([2_000, 1]);
        expect(coordinator.pendingCount).to.equal(1);
        now = 12_000;
        scheduled!();
        expect(resolutions).to.deep.equal([{ requestId: "request-1", outcome: "expired" }]);
        expect(
            coordinator.approve({ requestId: "request-1", promptNonce: NONCE, userVerified: true }, UI_URL)
        ).to.equal(false);
    });

    test("bounds lifetime, capacity, duplicate IDs, and internal cancellation", () => {
        expect(() => new PasskeyApprovalCoordinator({ approvalUiSenderUrl: UI_URL, ttlMs: 999 })).to.throw(RangeError);
        expect(() => new PasskeyApprovalCoordinator({ approvalUiSenderUrl: UI_URL, ttlMs: 120_001 })).to.throw(
            RangeError
        );

        const resolutions: PasskeyApprovalResolution[] = [];
        let nonceIndex = 0;
        const coordinator = new PasskeyApprovalCoordinator({
            approvalUiSenderUrl: UI_URL,
            maxPending: 1,
            nonceFactory: () => `${String(++nonceIndex).padStart(32, "0")}`,
        });
        coordinator.begin(metadata(), (resolution) => resolutions.push(resolution));
        expect(() => coordinator.begin(metadata(), () => {})).to.throw("already pending");
        expect(() => coordinator.begin(metadata({ requestId: "request-2" }), () => {})).to.throw("Too many");
        expect(coordinator.cancel("request-1")).to.equal(true);
        expect(coordinator.cancel("request-1")).to.equal(false);
        expect(resolutions).to.deep.equal([{ requestId: "request-1", outcome: "cancelled" }]);
    });

    test("rejects malformed display metadata and weak nonces", () => {
        const coordinator = new PasskeyApprovalCoordinator({ approvalUiSenderUrl: UI_URL, nonceFactory: () => "weak" });
        expect(() => coordinator.begin(metadata(), () => {})).to.throw("at least 128 bits");
        expect(() => coordinator.begin(metadata({ origin: "https://accounts.example/path" }), () => {})).to.throw(
            "verified origin"
        );
        expect(() => coordinator.begin(metadata({ rpId: "https://accounts.example" }), () => {})).to.throw(
            "verified RP ID"
        );
        expect(() => coordinator.begin(metadata({ rpName: "line\nbreak" }), () => {})).to.throw("RP name");
        coordinator.dispose();
    });
});

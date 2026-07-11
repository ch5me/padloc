import assert from "node:assert/strict";
import { EmailAuthMessage } from "@padloc/core/src/messenger";
import { ResendMessenger } from "../src/email/resend";
import { PersonalProvisioner } from "../src/provisioner/personal";

export async function run() {
    await testPersonalProvisionerLogs();
    await testResendFailureLogs();
    console.log("Worker logging redaction: PASS");
}

async function testPersonalProvisionerLogs() {
    const sentinels = {
        email: "sensitive-email-sentinel@example.invalid",
        password: "sensitive-password-sentinel",
        verifier: "sensitive-verifier-sentinel",
    };
    const accountId = "account-id-sentinel";
    const orgId = "org-id-sentinel";
    const captured: unknown[][] = [];
    const originalDebug = console.debug;

    try {
        console.debug = (...args: unknown[]) => captured.push(args);

        const provisioner = new PersonalProvisioner();
        await provisioner.getProvisioning({
            email: sentinels.email,
            accountId,
            orgs: [],
            password: sentinels.password,
            verifier: sentinels.verifier,
        } as never);
        await provisioner.accountDeleted({ email: sentinels.email, accountId });
        await provisioner.accountEmailChanged({
            prevEmail: sentinels.email,
            newEmail: sentinels.email,
            accountId,
        });
        await provisioner.orgDeleted({ id: orgId, name: "sensitive-org-name-sentinel" } as never);
        await provisioner.orgOwnerChanged(
            { id: orgId, name: "sensitive-org-name-sentinel" } as never,
            { email: sentinels.email, id: accountId },
            { email: sentinels.email, id: accountId }
        );
    } finally {
        console.debug = originalDebug;
    }

    const output = JSON.stringify(captured);

    for (const sentinel of [...Object.values(sentinels), accountId, orgId, "sensitive-org-name-sentinel"]) {
        assert.equal(output.includes(sentinel), false, `provisioner logs leaked sentinel: ${sentinel}`);
    }

    for (const forbiddenField of ["email", "password", "verifier", "prevEmail", "newEmail"]) {
        assert.equal(
            output.includes(forbiddenField),
            false,
            `provisioner logs exposed sensitive field: ${forbiddenField}`
        );
    }

    assert.deepEqual(captured[0], ["[PersonalProvisioner]", "getProvisioning", { hasAccountId: true, orgCount: 0 }]);
}

async function testResendFailureLogs() {
    const sentinels = {
        apiKey: "sensitive-resend-key-sentinel",
        recipient: "sensitive-recipient-sentinel@example.invalid",
        sender: "sensitive-sender-sentinel@example.invalid",
        code: "sensitive-otp-sentinel",
        requestId: "sensitive-request-sentinel",
        providerMessage: "sensitive-provider-error-sentinel",
    };
    const captured: unknown[][] = [];
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    let thrown: unknown;

    try {
        console.error = (...args: unknown[]) => captured.push(args);
        globalThis.fetch = (async () => ({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            json: async () => ({ message: sentinels.providerMessage }),
        })) as typeof fetch;

        try {
            await new ResendMessenger(sentinels.apiKey, sentinels.sender).send(
                sentinels.recipient,
                new EmailAuthMessage({ code: sentinels.code, requestId: sentinels.requestId })
            );
        } catch (error) {
            thrown = error;
        }
    } finally {
        console.error = originalError;
        globalThis.fetch = originalFetch;
    }

    assert.ok(thrown instanceof Error, "failed Resend request must throw");
    const output = JSON.stringify({ captured, thrown: String(thrown) });
    for (const sentinel of Object.values(sentinels)) {
        assert.equal(output.includes(sentinel), false, `Resend failure exposed sentinel: ${sentinel}`);
    }
    assert.deepEqual(captured, [["Resend send failed", { status: 400, template: "email-auth" }]]);
}

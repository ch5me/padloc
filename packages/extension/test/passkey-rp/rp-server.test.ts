import { strict as assert } from "assert";
import { once } from "events";
import { PasskeyCounterPolicy } from "@padloc/core/src/passkey";
import {
    buildPasskeyAssertionResponse,
    buildPasskeyRegistrationResponse,
    generatePasskeyCredential,
} from "@padloc/core/src/webauthn-authenticator";

const { createRpServer } = require("./rp-server.cjs");

suite("controlled passkey RP server", () => {
    let server: any;
    let origin: string;

    setup(async () => {
        const instance = createRpServer({ port: 0, origin: "http://localhost" });
        server = instance.server;
        server.listen(0, instance.host);
        await once(server, "listening");
        const address = server.address();
        origin = `http://127.0.0.1:${address.port}`;
    });

    teardown(async () => {
        server.close();
        await once(server, "close");
    });

    test("accepts registration and assertion once, then rejects replay", async () => {
        const registrationOptions = await post("/options/register");
        const credential = await generatePasskeyCredential({
            rpId: "localhost",
            rpName: "Controlled RP",
            userHandle: new Uint8Array([1, 2, 3, 4]),
            userName: "controlled-rp-test",
            userDisplayName: "Controlled RP Test",
            counterPolicy: PasskeyCounterPolicy.None,
            backupEligible: true,
            backupState: true,
        });
        const registration = await buildPasskeyRegistrationResponse(credential, {
            rpId: "localhost", origin: "http://localhost",
            challenge: decode(registrationOptions.challenge), userVerified: true,
        });
        const registrationBody = {
            ceremony: registrationOptions.ceremony,
            credentialID: encode(registration.rawId),
            clientDataJSON: encode(registration.clientDataJSON),
            attestationObject: encode(registration.attestationObject),
        };
        assert.equal((await post("/verify/register", registrationBody)).ok, true);
        const registrationStatus = await get("/status");
        assert.equal(registrationStatus.registrationVerified, true);
        assert.equal(registrationStatus.assertionCount, 0);
        assert.match(registrationStatus.credentialFingerprint, /^[0-9a-f]{16}$/);
        assert.equal((await post("/verify/register", registrationBody, 400)).category, "verification-rejected");

        const assertionOptions = await post("/options/assert");
        const assertion = await buildPasskeyAssertionResponse(credential, {
            rpId: "localhost",
            origin: "http://localhost",
            challenge: decode(assertionOptions.challenge),
            userVerified: true,
        });
        const assertionBody = {
            ceremony: assertionOptions.ceremony,
            credentialID: encode(assertion.rawId),
            clientDataJSON: encode(assertion.clientDataJSON),
            authenticatorData: encode(assertion.authenticatorData),
            signature: encode(assertion.signature),
        };
        assert.equal((await post("/verify/assert", assertionBody)).ok, true);
        const assertionStatus = await get("/status");
        assert.equal(assertionStatus.registrationVerified, true);
        assert.equal(assertionStatus.assertionCount, 1);
        assert.equal(assertionStatus.credentialFingerprint, registrationStatus.credentialFingerprint);
        assert.equal((await post("/verify/assert", assertionBody, 400)).category, "verification-rejected");
    });

    test("rejects malformed input and wrong credential without exposing details", async () => {
        const malformed = await post("/verify/register", { ceremony: "missing", credentialID: "%%%" }, 400);
        assert.deepEqual(malformed, { ok: false, category: "verification-rejected" });

        const options = await post("/options/register");
        const credential = await generatePasskeyCredential({
            rpId: "localhost", rpName: "Controlled RP", userHandle: new Uint8Array([5]),
            userName: "test", userDisplayName: "Test", counterPolicy: PasskeyCounterPolicy.None,
            backupEligible: true, backupState: true,
        });
        const registration = await buildPasskeyRegistrationResponse(credential, {
            rpId: "localhost", origin: "http://localhost", challenge: decode(options.challenge), userVerified: true,
        });
        const rejected = await post("/verify/register", {
            ceremony: options.ceremony,
            credentialID: encode(new Uint8Array([9, 9, 9])),
            clientDataJSON: encode(registration.clientDataJSON),
            attestationObject: encode(registration.attestationObject),
        }, 400);
        assert.deepEqual(rejected, { ok: false, category: "verification-rejected" });
    });

    async function post(path: string, body: unknown = {}, expectedStatus = 200) {
        const response = await fetch(`${origin}${path}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        assert.equal(response.status, expectedStatus);
        return response.json() as Promise<any>;
    }

    async function get(path: string) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 200);
        return response.json() as Promise<any>;
    }
});

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

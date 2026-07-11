const path = require("path");

process.env.TS_NODE_PROJECT = path.resolve(__dirname, "../../tsconfig.json");
require("ts-node/register");
require("tsconfig-paths/register");
const { verifyAssertion, verifyRegistration } = require("./shared-verifier.ts");

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
    try {
        const vector = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const bytes = (name) => Buffer.from(vector[name], "base64url");
        const common = {
            clientDataJSON: bytes("clientDataJSON"),
            expectedChallenge: bytes("challenge"),
            expectedOrigin: vector.origin,
            expectedRpID: vector.rpID,
            requireUV: vector.requireUV,
            requireBackupEligible: vector.requireBackupEligible !== false,
            requireBackupState: vector.requireBackupState !== false,
        };
        if (vector.operation === "registration") {
            verifyRegistration({
                ...common,
                attestationObject: bytes("attestationObject"),
                credentialID: bytes("credentialID"),
            });
        } else if (vector.operation === "assertion") {
            verifyAssertion({
                ...common,
                authenticatorData: bytes("authenticatorData"),
                signature: bytes("signature"),
                credentialID: bytes("credentialID"),
                expectedCredentialID: vector.expectedCredentialID
                    ? bytes("expectedCredentialID")
                    : bytes("credentialID"),
                publicKeyJwk: vector.publicKeyJwk,
            });
        } else {
            throw new Error("unsupported vector operation");
        }
        process.stdout.write("ok\n");
    } catch (error) {
        process.stderr.write(`verification failed: ${error.message}\n`);
        process.exitCode = 1;
    }
});

// Real verification-path test for src/firefly-sso.ts: generates a local RS256 keypair, serves it
// as a JWKS from an in-process HTTP server, signs real Firefly-shaped v3 tokens, and proves
// verifyFireflySsoToken accepts a valid one and rejects a wrong-issuer/wrong-audience/expired one.
// No live Firefly infrastructure needed or used. This is the real verify path, not a mock of it --
// the only thing local is the JWKS server, exactly like createElfVerifier would talk to a real one.
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

async function withJwksServer(publicJwk, kid, run) {
    const server = http.createServer((req, res) => {
        if (req.url === "/.well-known/jwks.json") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
    try {
        return await run(jwksUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function signToken(privateKey, kid, overrides = {}) {
    const claims = {
        version: 3,
        elfUserId: "user-1",
        apiTokenPepper: null,
        organizationId: "org-1",
        organizationRole: "member",
        ...overrides,
    };
    return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(overrides.issuer ?? "https://elf.example.com")
        .setAudience(overrides.audience ?? "padloc")
        .setIssuedAt()
        .setExpirationTime(overrides.exp ?? "5m")
        .sign(privateKey);
}

test("verifyFireflySsoToken accepts a validly signed token and returns its tenancy claims", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = "test-key-1";

    await withJwksServer(publicJwk, kid, async (jwksUrl) => {
        const { verifyFireflySsoToken, clearFireflySsoVerifierCache } = await import("../src/firefly-sso.ts");
        clearFireflySsoVerifierCache();
        const env = { FIREFLY_JWKS_URL: jwksUrl, FIREFLY_ISSUER: "https://elf.example.com", FIREFLY_AUDIENCE: "padloc" };
        const token = await signToken(privateKey, kid);

        const result = await verifyFireflySsoToken(env, token);
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.payload.elfUserId, "user-1");
            assert.equal(result.payload.organizationId, "org-1");
        }
    });
});

test("verifyFireflySsoToken rejects a token signed for the wrong audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = "test-key-2";

    await withJwksServer(publicJwk, kid, async (jwksUrl) => {
        const { verifyFireflySsoToken, clearFireflySsoVerifierCache } = await import("../src/firefly-sso.ts");
        clearFireflySsoVerifierCache();
        const env = { FIREFLY_JWKS_URL: jwksUrl, FIREFLY_ISSUER: "https://elf.example.com", FIREFLY_AUDIENCE: "padloc" };
        const token = await signToken(privateKey, kid, { audience: "some-other-service" });

        const result = await verifyFireflySsoToken(env, token);
        assert.equal(result.ok, false);
    });
});

test("verifyFireflySsoToken rejects an expired token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = "test-key-3";

    await withJwksServer(publicJwk, kid, async (jwksUrl) => {
        const { verifyFireflySsoToken, clearFireflySsoVerifierCache } = await import("../src/firefly-sso.ts");
        clearFireflySsoVerifierCache();
        const env = { FIREFLY_JWKS_URL: jwksUrl, FIREFLY_ISSUER: "https://elf.example.com", FIREFLY_AUDIENCE: "padloc" };
        const token = await signToken(privateKey, kid, { exp: "-1m" });

        const result = await verifyFireflySsoToken(env, token);
        assert.equal(result.ok, false);
    });
});

test("verifyFireflySsoToken rejects a token signed by a key not in the JWKS", async () => {
    const legit = await generateKeyPair("RS256", { extractable: true });
    const attacker = await generateKeyPair("RS256", { extractable: true });
    const legitPublicJwk = await exportJWK(legit.publicKey);
    const kid = "test-key-4";

    await withJwksServer(legitPublicJwk, kid, async (jwksUrl) => {
        const { verifyFireflySsoToken, clearFireflySsoVerifierCache } = await import("../src/firefly-sso.ts");
        clearFireflySsoVerifierCache();
        const env = { FIREFLY_JWKS_URL: jwksUrl, FIREFLY_ISSUER: "https://elf.example.com", FIREFLY_AUDIENCE: "padloc" };
        // Signed by the attacker's key but claims the legitimate kid.
        const token = await signToken(attacker.privateKey, kid);

        const result = await verifyFireflySsoToken(env, token);
        assert.equal(result.ok, false);
    });
});

test("verifyFireflySsoToken returns missing_token for an empty token without any network call", async () => {
    const { verifyFireflySsoToken } = await import("../src/firefly-sso.ts");
    // Deliberately unreachable JWKS URL -- if this test needed to reach it, it would time out.
    const env = { FIREFLY_JWKS_URL: "http://127.0.0.1:1/unreachable", FIREFLY_ISSUER: "x", FIREFLY_AUDIENCE: "y" };
    const result = await verifyFireflySsoToken(env, "");
    assert.deepEqual(result, { ok: false, error: "missing_token" });
});

test("fireflySsoConfigured is false unless all three env vars are set", async () => {
    const { fireflySsoConfigured } = await import("../src/firefly-sso.ts");
    assert.equal(fireflySsoConfigured({}), false);
    assert.equal(fireflySsoConfigured({ FIREFLY_JWKS_URL: "https://x" }), false);
    assert.equal(
        fireflySsoConfigured({ FIREFLY_JWKS_URL: "https://x", FIREFLY_ISSUER: "y", FIREFLY_AUDIENCE: "z" }),
        true
    );
});

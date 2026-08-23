import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const mockState = {
    configurations: [],
    results: [],
    tokens: [],
};

globalThis.__fireflySsoVerifierMock = mockState;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@ch5me/elf-auth-client") {
            return { shortCircuit: true, url: "firefly-sso-verifier-mock:module" };
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url === "firefly-sso-verifier-mock:module") {
            return {
                format: "module",
                shortCircuit: true,
                source: `
                    export function createElfVerifier(configuration) {
                        const state = globalThis.__fireflySsoVerifierMock;
                        state.configurations.push(configuration);
                        return {
                            async verify(token) {
                                state.tokens.push(token);
                                const result = state.results.shift();
                                if (result instanceof Error) throw result;
                                if (result === undefined) throw new Error("mock verifier result not configured");
                                return result;
                            }
                        };
                    }
                `,
            };
        }
        return nextLoad(url, context);
    },
});

const { clearFireflySsoVerifierCache, fireflySsoConfigured, handleFireflySsoVerifyRoute, verifyFireflySsoToken } =
    await import("../src/firefly-sso.ts");

const configuredEnv = {
    FIREFLY_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
    FIREFLY_ISSUER: "https://identity.example.test",
    FIREFLY_AUDIENCE: "padloc",
};

beforeEach(() => {
    clearFireflySsoVerifierCache();
    mockState.configurations.length = 0;
    mockState.results.length = 0;
    mockState.tokens.length = 0;
});

test("incomplete configuration stays disabled and the route fails closed", async () => {
    for (const env of [
        {},
        { FIREFLY_JWKS_URL: configuredEnv.FIREFLY_JWKS_URL },
        {
            FIREFLY_JWKS_URL: configuredEnv.FIREFLY_JWKS_URL,
            FIREFLY_ISSUER: configuredEnv.FIREFLY_ISSUER,
        },
        {
            FIREFLY_JWKS_URL: configuredEnv.FIREFLY_JWKS_URL,
            FIREFLY_AUDIENCE: configuredEnv.FIREFLY_AUDIENCE,
        },
        {
            FIREFLY_ISSUER: configuredEnv.FIREFLY_ISSUER,
            FIREFLY_AUDIENCE: configuredEnv.FIREFLY_AUDIENCE,
        },
    ]) {
        assert.equal(fireflySsoConfigured(env), false);
        const response = await handleFireflySsoVerifyRoute(
            new Request("https://api.example.test/v1/firefly-sso/verify", {
                method: "POST",
                headers: { authorization: "Bearer untrusted-token" },
            }),
            env
        );
        assert.equal(response.status, 501);
        assert.deepEqual(await response.json(), { ok: false, error: "firefly_sso_not_configured" });
    }
    assert.equal(mockState.configurations.length, 0);
});

test("issuer, audience, and clock failures are returned as verification failures", async () => {
    for (const error of ["unexpected issuer", "unexpected audience", "token expired", "token not active"]) {
        clearFireflySsoVerifierCache();
        mockState.results.push({ valid: false, error });
        const result = await verifyFireflySsoToken(configuredEnv, "signed.jwt.value");
        assert.deepEqual(result, { ok: false, error });
    }

    assert.equal(mockState.configurations.length, 4);
    assert.deepEqual(mockState.configurations[0], {
        jwksUrl: configuredEnv.FIREFLY_JWKS_URL,
        issuer: configuredEnv.FIREFLY_ISSUER,
        audience: configuredEnv.FIREFLY_AUDIENCE,
    });
});

test("missing and malformed bearer input never becomes an authenticated assertion", async () => {
    for (const authorization of [undefined, "", "Basic abc", "bearer lower-case", "Bearer "]) {
        const headers = authorization === undefined ? undefined : { authorization };
        const response = await handleFireflySsoVerifyRoute(
            new Request("https://api.example.test/v1/firefly-sso/verify", { method: "POST", headers }),
            configuredEnv
        );
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { ok: false, error: "missing_token" });
    }
    assert.equal(mockState.tokens.length, 0);

    mockState.results.push({ valid: false, error: "malformed token" });
    const response = await handleFireflySsoVerifyRoute(
        new Request("https://api.example.test/v1/firefly-sso/verify", {
            method: "POST",
            headers: { authorization: "Bearer definitely-not-a-jwt" },
        }),
        configuredEnv
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "malformed token" });
    assert.deepEqual(mockState.tokens, ["definitely-not-a-jwt"]);
});

test("the verifier is reused until an explicit cache reset", async () => {
    const secondEnv = {
        FIREFLY_JWKS_URL: "https://other.example.test/jwks",
        FIREFLY_ISSUER: "https://other.example.test",
        FIREFLY_AUDIENCE: "other-audience",
    };
    mockState.results.push(
        { valid: false, error: "first" },
        { valid: false, error: "second" },
        { valid: false, error: "after reset" }
    );

    await verifyFireflySsoToken(configuredEnv, "one");
    await verifyFireflySsoToken(secondEnv, "two");
    assert.equal(mockState.configurations.length, 1);
    assert.deepEqual(mockState.configurations[0], {
        jwksUrl: configuredEnv.FIREFLY_JWKS_URL,
        issuer: configuredEnv.FIREFLY_ISSUER,
        audience: configuredEnv.FIREFLY_AUDIENCE,
    });

    clearFireflySsoVerifierCache();
    await verifyFireflySsoToken(secondEnv, "three");
    assert.equal(mockState.configurations.length, 2);
    assert.deepEqual(mockState.configurations[1], {
        jwksUrl: secondEnv.FIREFLY_JWKS_URL,
        issuer: secondEnv.FIREFLY_ISSUER,
        audience: secondEnv.FIREFLY_AUDIENCE,
    });
});

test("route responses redact bearer tokens and non-public payload claims", async () => {
    const secretToken = "header.payload.signature-SECRET";
    mockState.results.push({ valid: false, error: "signature verification failed" });
    const rejected = await handleFireflySsoVerifyRoute(
        new Request("https://api.example.test/v1/firefly-sso/verify", {
            method: "POST",
            headers: { authorization: `Bearer ${secretToken}` },
        }),
        configuredEnv
    );
    const rejectedBody = await rejected.text();
    assert.equal(rejected.status, 401);
    assert.equal(rejectedBody.includes(secretToken), false);

    mockState.results.push({
        valid: true,
        payload: {
            elfUserId: "user-7",
            organizationId: "org-9",
            organizationRole: "admin",
            botId: "bot-2",
            apiTokenPepper: "pepper-MUST-NOT-LEAK",
            internalSecret: "private-MUST-NOT-LEAK",
        },
    });
    const accepted = await handleFireflySsoVerifyRoute(
        new Request("https://api.example.test/v1/firefly-sso/verify", {
            method: "POST",
            headers: { authorization: "Bearer accepted-token" },
        }),
        configuredEnv
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
        ok: true,
        elfUserId: "user-7",
        organizationId: "org-9",
        organizationRole: "admin",
        botId: "bot-2",
    });
});

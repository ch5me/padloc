import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_SECURITY_HEADERS,
    corsHeaders,
    generateRequestId,
    responseHeaders,
    securityHeaders,
} from "../src/observability/security-headers.ts";

const exactOrigin = "https://pad.ch5.me";
const newOrigin = "https://vault.elf.dance";

test("CORS origin and credential matrix", async (t) => {
    for (const vector of [
        { name: "exact origin", origin: exactOrigin },
        { name: "wildcard origin", origin: "*" },
    ]) {
        await t.test(vector.name, () => {
            const headers = corsHeaders({ allowOrigin: vector.origin });

            assert.equal(headers["Access-Control-Allow-Origin"], vector.origin);
            assert.equal(headers["Access-Control-Allow-Methods"], "OPTIONS, POST");
            assert.equal(headers["Access-Control-Allow-Headers"], "Content-Type");
            assert.equal(headers["Access-Control-Allow-Credentials"], undefined);
        });
    }
});

test("CORS methods, headers, and max-age are serialized exactly", () => {
    assert.deepEqual(
        corsHeaders({
            allowOrigin: exactOrigin,
            allowMethods: ["OPTIONS", "GET", "POST", "DELETE"],
            allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
            maxAge: 600,
        }),
        {
            "Access-Control-Allow-Origin": exactOrigin,
            "Access-Control-Allow-Methods": "OPTIONS, GET, POST, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
        }
    );
});

test("request-aware CORS echoes only an allowed old or new app origin", () => {
    const allowedOrigins = [newOrigin, exactOrigin];

    assert.equal(
        corsHeaders({ allowOrigin: newOrigin, allowedOrigins, requestOrigin: newOrigin })[
            "Access-Control-Allow-Origin"
        ],
        newOrigin
    );
    assert.equal(
        corsHeaders({ allowOrigin: newOrigin, allowedOrigins, requestOrigin: exactOrigin })[
            "Access-Control-Allow-Origin"
        ],
        exactOrigin
    );

    const denied = corsHeaders({
        allowOrigin: newOrigin,
        allowedOrigins,
        requestOrigin: "https://unknown.example.test",
    });
    assert.equal(denied["Access-Control-Allow-Origin"], undefined);
    assert.equal(denied.Vary, "Origin");
});

test("response header precedence allows explicit final overrides", () => {
    const headers = responseHeaders(
        { allowOrigin: exactOrigin },
        { hstsMaxAge: 60, includeSubDomains: true, preload: true },
        {
            "Access-Control-Allow-Origin": "https://admin.ch5.me",
            "Strict-Transport-Security": "max-age=120",
            "X-Request-ID": "request-from-edge",
        }
    );

    assert.equal(headers["Access-Control-Allow-Origin"], "https://admin.ch5.me");
    assert.equal(headers["Strict-Transport-Security"], "max-age=120");
    assert.equal(headers["X-Request-ID"], "request-from-edge");
    assert.equal(headers["X-Frame-Options"], "DENY");
});

test("security header defaults and directive overrides are deterministic", () => {
    assert.deepEqual(securityHeaders(), DEFAULT_SECURITY_HEADERS);
    assert.equal(securityHeaders().hasOwnProperty("Access-Control-Allow-Credentials"), false);

    const headers = securityHeaders({
        cspDirectives: {
            "default-src": ["'none'"],
            "frame-ancestors": ["'none'"],
        },
    });
    assert.equal(headers["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("newline-bearing header values are rejected by the platform Headers boundary", async (t) => {
    for (const vector of [
        { name: "origin", config: { allowOrigin: "https://pad.ch5.me\r\nX-Evil: injected" } },
        {
            name: "method",
            config: { allowOrigin: exactOrigin, allowMethods: ["POST\nX-Evil: injected"] },
        },
        {
            name: "extra response header",
            headers: responseHeaders({ allowOrigin: exactOrigin }, undefined, {
                "X-Request-ID": "valid\r\ninjected",
            }),
        },
    ]) {
        await t.test(vector.name, () => {
            const record = vector.headers ?? corsHeaders(vector.config);
            assert.throws(() => new Headers(record), TypeError);
        });
    }
});

test("OPTIONS preflight response exposes only the configured CORS matrix", () => {
    const request = new Request("https://api-pad.ch5.me/", {
        method: "OPTIONS",
        headers: {
            Origin: exactOrigin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    });
    const response = new Response(null, {
        status: 204,
        headers: responseHeaders({ allowOrigin: exactOrigin, maxAge: 86400 }),
    });

    assert.equal(request.method, "OPTIONS");
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), exactOrigin);
    assert.equal(response.headers.get("access-control-allow-methods"), "OPTIONS, POST");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
    assert.equal(response.headers.get("access-control-max-age"), "86400");
    assert.equal(response.headers.get("vary"), "Origin");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("request IDs match the timestamp-random contract and do not collide", () => {
    const ids = Array.from({ length: 128 }, () => generateRequestId());

    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
        assert.match(id, /^\d{13}-[a-z0-9]{9}$/);
        const timestamp = Number(id.split("-", 1)[0]);
        assert.ok(Math.abs(Date.now() - timestamp) < 1_000, `fresh timestamp in ${id}`);
    }
});

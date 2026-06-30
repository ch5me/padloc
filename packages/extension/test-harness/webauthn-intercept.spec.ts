import { chromium, expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const EXT_DIST = path.resolve(__dirname, "../dist");

test("main-world WebAuthn create is intercepted before native browser handling", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-webauthn-intercept-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${EXT_DIST}`,
            `--load-extension=${EXT_DIST}`,
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    });
    try {
        const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
        expect(worker.url()).toContain("chrome-extension://");

        const page = await context.newPage();
        await page.goto("https://example.com");
        await page.waitForLoadState("domcontentloaded");

        const unsupportedAlgorithm = await page.evaluate(async () => {
            try {
                await navigator.credentials.create({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { id: "example.com", name: "Example" },
                        user: {
                            id: crypto.getRandomValues(new Uint8Array(16)),
                            name: "agent@example.com",
                            displayName: "Agent",
                        },
                        pubKeyCredParams: [{ type: "public-key", alg: -257 }],
                    },
                });
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    name: error instanceof DOMException ? error.name : "",
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        });
        expect(unsupportedAlgorithm).toMatchObject({
            ok: false,
            name: "NotSupportedError",
        });

        const lockedVault = await page.evaluate(async () => {
            try {
                await Promise.race([
                    navigator.credentials.create({
                        publicKey: {
                            challenge: crypto.getRandomValues(new Uint8Array(32)),
                            rp: { id: "example.com", name: "Example" },
                            user: {
                                id: crypto.getRandomValues(new Uint8Array(16)),
                                name: "agent@example.com",
                                displayName: "Agent",
                            },
                            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                            authenticatorSelection: { userVerification: "required" },
                        },
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("harness-timeout")), 55_000)),
                ]);
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    name: error instanceof DOMException ? error.name : "",
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        });

        expect(lockedVault).toMatchObject({
            ok: false,
            name: "NotAllowedError",
        });
        expect((lockedVault as { message: string }).message).toContain("Padloc");
        expect((lockedVault as { message: string }).message).not.toContain("timed out");
    } finally {
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});

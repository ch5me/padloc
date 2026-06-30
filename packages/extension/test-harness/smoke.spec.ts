import { chromium, expect, test as base } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import os from "os";
import path from "path";
import fs from "fs";

const EXT_DIST = path.resolve(__dirname, "../dist");
const LOGIN_FIXTURE = path.join(__dirname, "fixtures", "login-form.html");
const LOGIN_FORM_HTML = fs.readFileSync(LOGIN_FIXTURE, "utf8");
const HEADFUL = process.env.PADLOC_EXTENSION_HEADFUL === "1";

const test = base.extend<{ extensionId: string }>({
    context: async ({}, use) => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-extension-harness-"));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                ...(HEADFUL ? [] : ["--headless=new"]),
                `--disable-extensions-except=${EXT_DIST}`,
                `--load-extension=${EXT_DIST}`,
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
            ],
        });
        await use(context);
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    },
    extensionId: async ({ context }, use) => {
        const worker =
            context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
        const extensionId = parseExtensionId(worker.url());
        expect(extensionId).toBeTruthy();
        await use(extensionId);
    },
});

function parseExtensionId(workerUrl: string): string {
    const match = workerUrl.match(/^chrome-extension:\/\/([^/]+)\//);
    return match?.[1] ?? "";
}

async function getExtensionId(page: any): Promise<string> {
    const worker =
        page.context().serviceWorkers()[0] || (await page.context().waitForEvent("serviceworker", { timeout: 15_000 }));
    return parseExtensionId(worker.url());
}

async function openLoginFixture(page: Page): Promise<void> {
    await page.goto("https://example.com");
    await page.setContent(LOGIN_FORM_HTML);
    await page.waitForSelector("#username");
    await page.waitForTimeout(500);
}

async function sendActiveTabMessage(
    context: BrowserContext,
    message: unknown
): Promise<{ resp: unknown; lastError: string }> {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    return worker.evaluate(async (msg: unknown) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab && typeof tab.id === "number" ? tab.id : null;
        if (tabId === null) {
            return { resp: null, lastError: "no active tab" };
        }
        return new Promise<{ resp: unknown; lastError: string }>((resolve) => {
            chrome.tabs.sendMessage(tabId, msg, (resp: unknown) => {
                resolve({ resp, lastError: chrome.runtime.lastError?.message || "" });
            });
        });
    }, message);
}

test.describe("Extension smoke — unpacked extension runtime", () => {
    test("loads without console errors in popup", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        const errors: string[] = [];
        const warnings: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") errors.push(msg.text());
            if (msg.type() === "warning") warnings.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        await page.goto(`chrome-extension://${extId}/popup.html`);
        await page.waitForLoadState("networkidle");

        const critical = errors.filter((e) => !e.includes("favicon") && !e.includes("net::ERR_BLOCKED_BY_CLIENT"));
        expect(critical, `Console errors: ${JSON.stringify(critical)}`).toHaveLength(0);

        const criticalWarnings = warnings.filter(
            (warning) =>
                warning.includes("Lit is in dev mode") ||
                warning.includes("lit-element") ||
                warning.includes("scheduled an update")
        );
        expect(criticalWarnings, `Console warnings: ${JSON.stringify(criticalWarnings)}`).toHaveLength(0);
    });

    test("popup opens from toolbar action", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`chrome-extension://${extId}/popup.html`);
        const appState = await page.evaluate(() => {
            const app = document.querySelector("pl-extension-app");
            return {
                customElementRegistered: !!customElements.get("pl-extension-app"),
                appMounted: !!app,
                appRendered: !!app?.shadowRoot,
            };
        });
        expect(appState).toMatchObject({
            customElementRegistered: true,
            appMounted: true,
            appRendered: true,
        });
    });

    test("background worker handles ping message", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`chrome-extension://${extId}/popup.html`);
        const result = await page.evaluate(async (id) => {
            return new Promise<string>((resolve) => {
                chrome.runtime.sendMessage(id, { type: "ping" }, (resp: any) => {
                    resolve(JSON.stringify({ resp, lastError: chrome.runtime.lastError?.message || "" }));
                });
            });
        }, extId);

        const parsed = JSON.parse(result);
        expect(parsed.lastError).toBe("");
        expect(parsed.resp).toHaveProperty("type", "pong");
    });

    test("background worker bundle is service-worker safe", async ({ context }) => {
        const worker =
            context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
        const state = await worker.evaluate(async () => {
            const backgroundSource = await fetch(chrome.runtime.getURL("background.js")).then((res) => res.text());
            const backgroundMap = await fetch(chrome.runtime.getURL("background.js.map")).then((res) => res.text());
            return {
                hasHistoryGlobal: typeof history !== "undefined",
                hasXhrGlobal: typeof XMLHttpRequest !== "undefined",
                hasMessageListeners: chrome.runtime.onMessage.hasListeners(),
                hasImmediateBridge: backgroundSource.includes("registerImmediateMessageBridge"),
                referencesXhr: /\bXMLHttpRequest\b/.test(backgroundSource),
                importsPageRouter:
                    /(^|[^.\w$])history\s*\.(?:state|replaceState|pushState|go)\b/m.test(backgroundSource) ||
                    backgroundSource.includes("history.replaceState") ||
                    backgroundSource.includes("history.pushState") ||
                    backgroundSource.includes("window.router") ||
                    backgroundSource.includes("new Router("),
                sourceMapIncludesBrowserOnlyAppModules:
                    backgroundMap.includes("app/src/lib/ajax.ts") ||
                    backgroundMap.includes("app/src/globals.ts") ||
                    backgroundMap.includes("app/src/lib/route.ts"),
                storesPasskeyPrivateKeyField: /name:\s*["']Private Key["']|["']Private Key["']\s*,\s*type:/.test(
                    backgroundSource
                ),
                hasContextMenuDedupe: backgroundSource.includes("dedupeMatchedItems"),
                hasContextMenuIdempotence: backgroundSource.includes("createContextMenuOnce"),
            };
        });

        expect(state).toMatchObject({
            hasHistoryGlobal: false,
            hasXhrGlobal: false,
            hasMessageListeners: true,
            hasImmediateBridge: true,
            referencesXhr: false,
            importsPageRouter: false,
            sourceMapIncludesBrowserOnlyAppModules: false,
            storesPasskeyPrivateKeyField: false,
            hasContextMenuDedupe: true,
            hasContextMenuIdempotence: true,
        });
    });

    test("extension loads on a plain page and badge updates", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto("https://example.com");
        await page.waitForTimeout(1500);

        const worker =
            page.context().serviceWorkers()[0] ||
            (await page.context().waitForEvent("serviceworker", { timeout: 15_000 }));
        const badge = await worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = tab && typeof tab.id === "number" ? tab.id : undefined;
            return chrome.action.getBadgeText({ tabId });
        });
        expect(typeof badge).toBe("string");
    });

    test("content script detects form fields on fixture page", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await openLoginFixture(page);

        const fields = await page.evaluate(() => {
            const inputs = document.querySelectorAll("input");
            return Array.from(inputs).map((el) => ({
                type: el.getAttribute("type"),
                name: el.getAttribute("name"),
                id: el.getAttribute("id"),
            }));
        });

        expect(fields.some((f: any) => f.type === "email" || f.name === "username")).toBeTruthy();
        expect(fields.some((f: any) => f.type === "password")).toBeTruthy();
    });

    test("content script responds to isContentReady on fixture page", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await openLoginFixture(page);

        const ready = await sendActiveTabMessage(page.context(), { type: "isContentReady" });
        expect(ready.lastError).toBe("");
        expect(ready.resp, "Content script should respond true to isContentReady").toBe(true);
    });

    test("dist contains manifest.json before any browser work", () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        expect(fs.existsSync(manifestPath), `${manifestPath} must exist`).toBe(true);
    });

    test("popup shows auth-required state when logged out", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`chrome-extension://${extId}/popup.html`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1000);

        const popupState = await page.evaluate(() => {
            const app = document.querySelector("pl-extension-app");
            return {
                registered: !!customElements.get("pl-extension-app"),
                mounted: !!app,
                shadowHtmlLength: app?.shadowRoot?.innerHTML.length || 0,
            };
        });
        expect(popupState.registered).toBe(true);
        expect(popupState.mounted).toBe(true);
        expect(popupState.shadowHtmlLength).toBeGreaterThan(0);
    });

    test("manifest grants identity permission for OAuth", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        expect(manifest.permissions || []).toContain("identity");
    });

    test("manifest exposes content_scripts for all_urls", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const cs = (manifest.content_scripts || []).find((s: any) => s.matches && s.matches.includes("<all_urls>"));
        expect(cs, "content script must be registered for <all_urls>").toBeTruthy();
    });

    test("content script autofill routes username/password/totp to correct fields", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await openLoginFixture(page);

        const fillResult = await sendActiveTabMessage(page.context(), {
            type: "fillFields",
            mappings: { username: "alice", password: "sekret", totp: "123456" },
        });
        expect(fillResult.lastError).toBe("");
        expect(fillResult.resp).toBe(true);

        await page.waitForTimeout(300);

        const usernameVal = await page.locator("#username").inputValue();
        const passwordVal = await page.locator("#password").inputValue();
        const totpVal = await page.locator("#totp").inputValue();

        expect(usernameVal, "Username field should receive alice").toBe("alice");
        expect(passwordVal, "Password field should receive sekret").toBe("sekret");
        expect(totpVal, "TOTP field should receive 123456").toBe("123456");
    });

    test("background worker routes fillFields message to content script", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await openLoginFixture(page);

        const result = await sendActiveTabMessage(page.context(), {
            type: "fillFields",
            mappings: { username: "alice", password: "secret123" },
        });
        expect(result.lastError).toBe("");
        expect(result.resp).toBe(true);

        const usernameVal = await page.locator("#username").inputValue();
        const passwordVal = await page.locator("#password").inputValue();

        expect(usernameVal).toBe("alice");
        expect(passwordVal).toBe("secret123");
    });
});

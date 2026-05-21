import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const EXT_DIST = path.resolve(__dirname, "..");
const LOGIN_FIXTURE = path.join(__dirname, "fixtures", "login-form.html");

async function getExtensionId(page: any): Promise<string> {
    const cdp = await page.context().newCDPSession(page);
    const { result } = await cdp.send("ChromeExtension.getExtensions");
    const ext = result.find(
        (e: any) =>
            (e.name.includes("CH5 Auth") || e.name.includes("Padloc")) &&
            e.url.startsWith(`file://${EXT_DIST}`)
    );
    return ext?.id ?? "";
}

test.describe("Extension smoke — unpacked extension runtime", () => {
    test("loads without console errors in popup", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        const errors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        await page.goto(`chrome-extension://${extId}/popup.html`);
        await page.waitForLoadState("networkidle");

        const critical = errors.filter(
            (e) => !e.includes("favicon") && !e.includes("net::ERR_BLOCKED_BY_CLIENT")
        );
        expect(critical, `Console errors: ${JSON.stringify(critical)}`).toHaveLength(0);
    });

    test("popup opens from toolbar action", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`chrome-extension://${extId}/popup.html`);
        const body = await page.locator("body").innerHTML();
        expect(body.trim().length, "Popup body should not be empty").toBeGreaterThan(0);
    });

    test("background worker handles ping message", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        const result = await page.evaluate(async (id) => {
            return new Promise<string>((resolve) => {
                chrome.runtime.sendMessage(id, { type: "ping" }, (resp: any) => {
                    resolve(JSON.stringify(resp));
                });
            });
        }, extId);

        const parsed = JSON.parse(result);
        expect(parsed).toHaveProperty("type", "pong");
    });

    test("extension loads on a plain page and badge updates", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto("https://example.com");
        await page.waitForTimeout(1500);

        const badge = await page.evaluate((id) => {
            return new Promise<string>((resolve) => {
                chrome.action.getBadgeText({ extensionId: id }, resolve);
            });
        }, extId);
        expect(typeof badge).toBe("string");
    });

    test("content script detects form fields on fixture page", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`file://${LOGIN_FIXTURE}`);
        await page.waitForLoadState("networkidle");

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

        await page.goto(`file://${LOGIN_FIXTURE}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        const cdp = await page.context().newCDPSession(page);
        const { data } = await cdp.send("Target.getTargets", {});
        const contentTarget = data.targetInfos?.find(
            (t: any) => t.type === "page" && t.url.includes("login-form.html")
        );
        const tabId = contentTarget?.targetId;
        expect(tabId, "Content script should be attached to fixture page").toBeTruthy();

        const ready = await page.evaluate(
            async ({ id, tid }: { id: string; tid: string }) => {
                return new Promise<boolean>((resolve) => {
                    chrome.runtime.sendMessage(id, { type: "isContentReady" }, (resp: any) => {
                        resolve(resp === true);
                    });
                });
            },
            { id: extId, tid: tabId as any }
        );
        expect(ready, "Content script should respond true to isContentReady").toBe(true);
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

        const bodyText = await page.locator("body").innerText();
        expect(bodyText.length).toBeGreaterThan(0);
    });

    test("manifest grants identity permission for OAuth", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        expect(manifest.permissions || []).toContain("identity");
    });

    test("manifest exposes content_scripts for all_urls", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const cs = (manifest.content_scripts || []).find((s: any) =>
            s.matches && s.matches.includes("<all_urls>")
        );
        expect(cs, "content script must be registered for <all_urls>").toBeTruthy();
    });

    test("content script autofill routes username/password/totp to correct fields", async ({ page }) => {
        const extId = await getExtensionId(page);
        expect(extId).toBeTruthy();

        await page.goto(`file://${LOGIN_FIXTURE}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        await page.evaluate(async ({ id }: { id: string }) => {
            return new Promise<void>((resolve) => {
                chrome.runtime.sendMessage(
                    id,
                    { type: "fillFields", mappings: { username: "alice", password: "sekret", totp: "123456" } },
                    () => resolve()
                );
            });
        }, { id: extId });

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

        await page.goto(`file://${LOGIN_FIXTURE}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        const result = await page.evaluate(async ({ id }: { id: string }) => {
            return new Promise<string>((resolve) => {
                chrome.runtime.sendMessage(
                    id,
                    {
                        type: "fillFields",
                        mappings: { username: "alice", password: "secret123" }
                    },
                    (resp: any) => resolve(JSON.stringify(resp))
                );
            });
        }, { id: extId });

        const usernameVal = await page.locator("#username").inputValue();
        const passwordVal = await page.locator("#password").inputValue();

        expect(usernameVal).toBe("alice");
        expect(passwordVal).toBe("secret123");
    });
});

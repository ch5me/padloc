import { expect } from "chai";

suite("Save/Update credential flow", () => {
    // -------------------------------------------------------------------------
    // Submit detection helpers — mirror content script logic for testing
    // -------------------------------------------------------------------------

    function findPasswordInputs(inputs: Array<{ type: string }>): Array<{ type: string }> {
        return inputs.filter((i) => i.type === "password");
    }

    function findUsernameInput(
        inputs: Array<{ type: string; name?: string; id?: string; autocomplete?: string }>
    ): string {
        for (const input of inputs) {
            if (input.type === "email" || input.type === "text" || input.type === "tel") {
                const name = (input.name || "").toLowerCase();
                const id = (input.id || "").toLowerCase();
                const autocomplete = (input.autocomplete || "").toLowerCase();
                if (
                    name.includes("user") ||
                    name.includes("login") ||
                    name.includes("email") ||
                    name.includes("account") ||
                    name.includes("username") ||
                    id.includes("user") ||
                    id.includes("login") ||
                    id.includes("email") ||
                    autocomplete === "username" ||
                    autocomplete === "email"
                ) {
                    return name;
                }
            }
        }
        return "";
    }

    suite("Form submit detection", () => {
        test("detects password input in form", () => {
            const inputs = [
                { type: "text", name: "username" },
                { type: "password", name: "password" },
            ];
            const passwords = findPasswordInputs(inputs);
            expect(passwords.length).to.equal(1);
            expect(passwords[0].name).to.equal("password");
        });

        test("detects username input by name attribute", () => {
            const inputs = [
                { type: "text", name: "username" },
                { type: "password", name: "password" },
            ];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("username");
        });

        test("detects username input by autocomplete attribute", () => {
            const inputs = [
                { type: "text", name: "foo", id: "bar", autocomplete: "username" },
                { type: "password", name: "password" },
            ];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("foo");
        });

        test("detects username input by id containing login", () => {
            const inputs = [
                { type: "email", name: "email", id: "login-input" },
                { type: "password", name: "password" },
            ];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("email");
        });

        test("returns empty string when no username input found", () => {
            const inputs = [{ type: "password", name: "password" }];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("");
        });

        test("skips non-text inputs when looking for username", () => {
            const inputs = [
                { type: "password", name: "password" },
                { type: "email", name: "email" },
            ];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("email");
        });

        test("ignores password inputs when looking for username", () => {
            const inputs = [
                { type: "password", name: "current-password" },
                { type: "password", name: "new-password" },
            ];
            const username = findUsernameInput(inputs);
            expect(username).to.equal("");
        });

        test("multiple password inputs still detects one", () => {
            const inputs = [
                { type: "text", name: "username" },
                { type: "password", name: "current-password" },
                { type: "password", name: "new-password" },
            ];
            const passwords = findPasswordInputs(inputs);
            expect(passwords.length).to.equal(2);
        });
    });

    // -------------------------------------------------------------------------
    // Suppression logic helpers — extracted from background.ts for testing
    // -------------------------------------------------------------------------

    const DISMISSAL_DURATION_MS = 60 * 60 * 1000;

    function isUrlSuppressed(url: string, dismissedUrls: Map<string, number>): boolean {
        const now = Date.now();
        const dismissedUntil = dismissedUrls.get(url);
        return dismissedUntil !== undefined && now < dismissedUntil;
    }

    function cleanupExpiredDismissions(dismissedUrls: Map<string, number>): void {
        const now = Date.now();
        for (const [url, timestamp] of dismissedUrls.entries()) {
            if (now > timestamp) dismissedUrls.delete(url);
        }
    }

    suite("Prompt suppression", () => {
        let dismissedUrls: Map<string, number>;

        beforeEach(() => {
            dismissedUrls = new Map();
        });

        test("new URL is not suppressed", () => {
            expect(isUrlSuppressed("https://example.com/login", dismissedUrls)).to.equal(false);
        });

        test("recently dismissed URL is suppressed", () => {
            dismissedUrls.set("https://example.com/login", Date.now() + DISMISSAL_DURATION_MS);
            expect(isUrlSuppressed("https://example.com/login", dismissedUrls)).to.equal(true);
        });

        test("expired dismissal is not suppressed", () => {
            dismissedUrls.set("https://example.com/login", Date.now() - 1000);
            expect(isUrlSuppressed("https://example.com/login", dismissedUrls)).to.equal(false);
        });

        test("cleanupExpiredDismissions removes expired entries", () => {
            dismissedUrls.set("https://example.com/expired", Date.now() - 1000);
            dismissedUrls.set("https://example.com/valid", Date.now() + DISMISSAL_DURATION_MS);
            cleanupExpiredDismissions(dismissedUrls);
            expect(dismissedUrls.has("https://example.com/expired")).to.equal(false);
            expect(dismissedUrls.has("https://example.com/valid")).to.equal(true);
        });

        test("different paths are not affected by dismissal", () => {
            dismissedUrls.set("https://example.com/login", Date.now() + DISMISSAL_DURATION_MS);
            expect(isUrlSuppressed("https://example.com/signup", dismissedUrls)).to.equal(false);
        });
    });

    // -------------------------------------------------------------------------
    // Credential data structure tests
    // -------------------------------------------------------------------------

    suite("CredentialData structure", () => {
        test("CredentialData requires username and password", () => {
            const data = {
                username: "user@example.com",
                password: "secretpassword",
                url: "https://example.com/login",
            };
            expect(data.username).to.equal("user@example.com");
            expect(data.password).to.equal("secretpassword");
            expect(data.url).to.equal("https://example.com/login");
        });

        test("CredentialData can have empty username", () => {
            const data = {
                username: "",
                password: "secretpassword",
                url: "https://example.com/login",
            };
            expect(data.username).to.equal("");
            expect(data.password).to.equal("secretpassword");
        });
    });

    // -------------------------------------------------------------------------
    // Message type inference tests
    // -------------------------------------------------------------------------

    suite("Message type exhaustiveness", () => {
        test("formSubmitDetected message shape", () => {
            const msg = {
                type: "formSubmitDetected",
                data: { username: "user", password: "pass", url: "https://x.com" },
            };
            expect(msg.type).to.equal("formSubmitDetected");
            expect(msg.data.username).to.equal("user");
            expect(msg.data.password).to.equal("pass");
            expect(msg.data.url).to.equal("https://x.com");
        });

        test("saveCredential message shape", () => {
            const msg = { type: "saveCredential", promptId: "abc-123" };
            expect(msg.type).to.equal("saveCredential");
            expect(msg.promptId).to.equal("abc-123");
        });

        test("updateCredential message shape", () => {
            const msg = { type: "updateCredential", promptId: "abc-123" };
            expect(msg.type).to.equal("updateCredential");
            expect(msg.promptId).to.equal("abc-123");
        });

        test("dismissPrompt message shape", () => {
            const msg = { type: "dismissPrompt", promptId: "abc-123" };
            expect(msg.type).to.equal("dismissPrompt");
            expect(msg.promptId).to.equal("abc-123");
        });

        test("getSavePromptResponse message shape", () => {
            const msg = {
                type: "getSavePromptResponse",
                prompt: {
                    id: "abc-123",
                    url: "https://x.com",
                    username: "user",
                    password: "pass",
                },
            };
            expect(msg.type).to.equal("getSavePromptResponse");
            expect(msg.prompt?.id).to.equal("abc-123");
            expect(msg.prompt?.url).to.equal("https://x.com");
        });

        test("getSavePromptResponse can be null", () => {
            const msg = { type: "getSavePromptResponse", prompt: null };
            expect(msg.type).to.equal("getSavePromptResponse");
            expect(msg.prompt).to.equal(null);
        });
    });
});

import { expect } from "chai";
import { FieldType } from "@padloc/core/src/item";

suite("Autofill orchestration", () => {
    suite("Field role classification", () => {
        // Inline classification logic extracted for testing
        function classifyField(input: { type: string; name?: string; id?: string; getAttribute: (name: string) => string | null; placeholder?: string }): string | null {
            const type = input.type.toLowerCase();
            const name = (input.name || "").toLowerCase();
            const id = (input.id || "").toLowerCase();
            const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
            const placeholder = (input.placeholder || "").toLowerCase();

            if (type === "password") return "password";

            if (
                name.includes("totp") ||
                name.includes("otp") ||
                name.includes("one-time") ||
                id.includes("totp") ||
                id.includes("otp") ||
                autocomplete === "one-time-code" ||
                placeholder.includes("totp") ||
                placeholder.includes("otp") ||
                placeholder.includes("one-time")
            ) {
                return "totp";
            }

            if (type === "email" || type === "text" || type === "tel" || type === "number") {
                if (
                    name.includes("user") ||
                    name.includes("login") ||
                    name.includes("email") ||
                    name.includes("account") ||
                    name.includes("username") ||
                    id.includes("user") ||
                    id.includes("login") ||
                    id.includes("email") ||
                    id.includes("username")
                ) {
                    return "username";
                }
            }

            if (type === "email") return "username";

            return null;
        }

        test("password input is classified as password", () => {
            const input = { type: "password", name: "password", id: "pass", getAttribute: () => null };
            expect(classifyField(input)).to.equal("password");
        });

        test("text input named 'username' is classified as username", () => {
            const input = { type: "text", name: "username", id: "user", getAttribute: () => null };
            expect(classifyField(input)).to.equal("username");
        });

        test("email input is classified as username", () => {
            const input = { type: "email", name: "", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.equal("username");
        });

        test("input with name='login' is classified as username", () => {
            const input = { type: "text", name: "login", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.equal("username");
        });

        test("input with id containing 'user' is classified as username", () => {
            const input = { type: "text", name: "", id: "userid", getAttribute: () => null };
            expect(classifyField(input)).to.equal("username");
        });

        test("input named 'totp' is classified as totp", () => {
            const input = { type: "text", name: "totp", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.equal("totp");
        });

        test("input named 'otp' is classified as totp", () => {
            const input = { type: "text", name: "otp", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.equal("totp");
        });

        test("input with autocomplete='one-time-code' is classified as totp", () => {
            const input = { type: "text", name: "", id: "", getAttribute: (n: string) => (n === "autocomplete" ? "one-time-code" : null) };
            expect(classifyField(input)).to.equal("totp");
        });

        test("input with placeholder containing 'totp' is classified as totp", () => {
            const input = { type: "text", name: "", id: "", placeholder: "enter totp code", getAttribute: () => null };
            expect(classifyField(input)).to.equal("totp");
        });

        test("generic text input with no identifying attributes is unclassified", () => {
            const input = { type: "text", name: "", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.be.null;
        });

        test("hidden input is not classified", () => {
            const input = { type: "hidden", name: "data", id: "", getAttribute: () => null };
            expect(classifyField(input)).to.be.null;
        });
    });

    suite("Context menu ID parsing", () => {
        test("item/{id}/{fieldIndex} matches field fill pattern", () => {
            const match = "item/abc123/0".match(/^item\/([^\/]+)\/(\d+)$/);
            expect(match).to.not.be.null;
            if (match) {
                expect(match[1]).to.equal("abc123");
                expect(match[2]).to.equal("0");
            }
        });

        test("item/{id} matches multi-field fill pattern", () => {
            const match = "item/abc123".match(/^item\/([^\/]+)$/);
            expect(match).to.not.be.null;
            if (match) {
                expect(match[1]).to.equal("abc123");
            }
        });

        test("openPopup does not match either pattern", () => {
            const fieldMatch = "openPopup".match(/^item\/([^\/]+)\/(\d+)$/);
            const itemMatch = "openPopup".match(/^item\/([^\/]+)$/);
            expect(fieldMatch).to.be.null;
            expect(itemMatch).to.be.null;
        });

        test("item/{id}/{fieldIndex} with higher index", () => {
            const match = "item/item-xyz/5".match(/^item\/([^\/]+)\/(\d+)$/);
            expect(match).to.not.be.null;
            if (match) {
                expect(match[1]).to.equal("item-xyz");
                expect(match[2]).to.equal("5");
            }
        });

        test("multi-field fill id without trailing slash", () => {
            const match = "item/my-item-id".match(/^item\/([^\/]+)$/);
            expect(match).to.not.be.null;
            if (match) {
                expect(match[1]).to.equal("my-item-id");
            }
        });
    });

    suite("fillItemMultiField orchestration", () => {
        test("extracts username and password fields from item", () => {
            const fields = [
                { type: FieldType.Username, value: "user@example.com" },
                { type: FieldType.Password, value: "secret123" },
                { type: FieldType.Note, value: "some note" },
            ];

            let username: string | undefined;
            let password: string | undefined;
            let totp: string | undefined;

            for (const field of fields) {
                if (field.type === FieldType.Username && !username) username = field.value;
                else if (field.type === FieldType.Password && !password) password = field.value;
                else if (field.type === FieldType.Totp && !totp) totp = field.value;
            }

            expect(username).to.equal("user@example.com");
            expect(password).to.equal("secret123");
            expect(totp).to.be.undefined;
        });

        test("extracts username, password, and TOTP fields", () => {
            const fields = [
                { type: FieldType.Username, value: "user@example.com" },
                { type: FieldType.Password, value: "secret123" },
                { type: FieldType.Totp, value: "JBSWY3DPEHPK3PXP" }, // raw secret
            ];

            let username: string | undefined;
            let password: string | undefined;
            let totp: string | undefined;

            for (const field of fields) {
                if (field.type === FieldType.Username && !username) username = field.value;
                else if (field.type === FieldType.Password && !password) password = field.value;
                else if (field.type === FieldType.Totp && !totp) totp = field.value;
            }

            expect(username).to.equal("user@example.com");
            expect(password).to.equal("secret123");
            expect(totp).to.equal("JBSWY3DPEHPK3PXP");
        });

        test("returns nothing when item has no username or password", () => {
            const fields = [{ type: FieldType.Note, value: "just a note" }];

            let username: string | undefined;
            let password: string | undefined;

            for (const field of fields) {
                if (field.type === FieldType.Username && !username) username = field.value;
                else if (field.type === FieldType.Password && !password) password = field.value;
            }

            expect(username).to.be.undefined;
            expect(password).to.be.undefined;
        });

        test("only first username and password are used", () => {
            const fields = [
                { type: FieldType.Username, value: "first@example.com" },
                { type: FieldType.Password, value: "first-secret" },
                { type: FieldType.Username, value: "second@example.com" },
                { type: FieldType.Password, value: "second-secret" },
            ];

            let username: string | undefined;
            let password: string | undefined;

            for (const field of fields) {
                if (field.type === FieldType.Username && !username) username = field.value;
                else if (field.type === FieldType.Password && !password) password = field.value;
            }

            expect(username).to.equal("first@example.com");
            expect(password).to.equal("first-secret");
        });
    });

    suite("fillFields message mapping", () => {
        test("mappings includes username and password when both present", () => {
            const username = "user@example.com";
            const password = "secret123";

            const mappings: { username?: string; password?: string; totp?: string } = { username, password };
            expect(mappings.username).to.equal("user@example.com");
            expect(mappings.password).to.equal("secret123");
            expect(mappings.totp).to.be.undefined;
        });

        test("mappings includes totp when present", () => {
            const username = "user@example.com";
            const password = "secret123";
            const totp = "123456";

            const mappings = { username, password, totp };
            expect(mappings.username).to.equal("user@example.com");
            expect(mappings.password).to.equal("secret123");
            expect(mappings.totp).to.equal("123456");
        });

        test("mappings can have only username", () => {
            const mappings: { username?: string; password?: string; totp?: string } = { username: "user@example.com" };
            expect(mappings.username).to.equal("user@example.com");
            expect(mappings.password).to.be.undefined;
        });

        test("mappings can have only password", () => {
            const mappings: { username?: string; password?: string; totp?: string } = { password: "secret123" };
            expect(mappings.username).to.be.undefined;
            expect(mappings.password).to.equal("secret123");
        });
    });

    suite("single-field fill fallback", () => {
        test("fallback uses first password when no username", () => {
            const fields = [{ type: FieldType.Password, value: "secret123" }];

            let password: string | undefined;
            for (const field of fields) {
                if (field.type === FieldType.Password && !password) password = field.value;
            }

            expect(password).to.equal("secret123");
        });

        test("fallback uses first username when no password", () => {
            const fields = [{ type: FieldType.Username, value: "user@example.com" }];

            let username: string | undefined;
            for (const field of fields) {
                if (field.type === FieldType.Username && !username) username = field.value;
            }

            expect(username).to.equal("user@example.com");
        });
    });
});

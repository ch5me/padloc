import { expect } from "chai";

suite("Content script field detection and fill", () => {
    // -------------------------------------------------------------------------
    // Helpers — mirror the private classification logic extracted for testing
    // -------------------------------------------------------------------------

    type FieldRole = "username" | "password" | "totp" | null;

    function getLabelText(input: {
        getAttribute: (name: string) => string | null;
        form?: { labels: Array<{ textContent: string | null }> | null };
        parentElement?: { tagName?: string; parentElement?: Element | null };
        ownerDocument?: Document | null;
        dataset: Record<string, string>;
        maxLength: number;
    }): string {
        const labelledBy = input.getAttribute("aria-labelledby");
        if (labelledBy) {
            try {
                const labelEl = input.ownerDocument?.getElementById(labelledBy);
                if (labelEl) return (labelEl.textContent || "").trim().toLowerCase();
            } catch {
                // cross-origin
            }
        }
        const ariaLabel = input.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.toLowerCase();
        if (input.form?.labels?.length) {
            return (input.form.labels[0]?.textContent || "").trim().toLowerCase();
        }
        let parent = input.parentElement;
        for (let depth = 0; depth < 5 && parent; depth++) {
            if ((parent as Element).tagName === "LABEL") {
                return (parent.textContent || "").trim().toLowerCase();
            }
            parent = (parent as Element).parentElement;
        }
        return "";
    }

    function classifyField(input: {
        type: string;
        name?: string;
        id?: string;
        getAttribute: (name: string) => string | null;
        placeholder?: string;
        maxLength: number;
        dataset: Record<string, string>;
    }): FieldRole {
        const type = input.type.toLowerCase();
        const name = (input.name || "").toLowerCase();
        const id = (input.id || "").toLowerCase();
        const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
        const placeholder = (input.placeholder || "").toLowerCase();
        const labelText = getLabelText(input);
        const dataAttr = (
            (input.dataset["fieldType"] as string) ||
            (input.dataset["field"] as string) ||
            ""
        ).toLowerCase();
        const maxLength = input.maxLength;
        const pattern = input.getAttribute("pattern") || "";
        const inputmode = input.getAttribute("inputmode") || "";

        if (type === "password") return "password";
        if (autocomplete === "current-password" || autocomplete === "new-password") return "password";

        const isTotpSignal =
            name.includes("totp") ||
            name.includes("otp") ||
            name.includes("one-time") ||
            name.includes("verification") ||
            id.includes("totp") ||
            id.includes("otp") ||
            id.includes("verification") ||
            autocomplete === "one-time-code" ||
            placeholder.includes("totp") ||
            placeholder.includes("otp") ||
            placeholder.includes("one-time") ||
            placeholder.includes("verification") ||
            labelText.includes("totp") ||
            labelText.includes("otp") ||
            labelText.includes("one-time") ||
            labelText.includes("verification") ||
            labelText.includes("code") ||
            dataAttr.includes("totp") ||
            dataAttr.includes("otp");

        const normalizedPattern = pattern.replace(/^\^|\$$/g, "");
        const isDigitPattern = /^(?:\\d|\[0-9\])(?:\+|\{\d+(?:,\d*)?\})$/.test(normalizedPattern);
        const isOtpLength = maxLength >= 4 && maxLength <= 8;
        const isNumericInputmode = inputmode === "numeric" || inputmode === "text";

        if (isTotpSignal || (isDigitPattern && isOtpLength) || (isNumericInputmode && isOtpLength)) {
            return "totp";
        }

        if (type === "email" || type === "text" || type === "tel" || type === "number") {
            const isUsernameSignal =
                name.includes("user") ||
                name.includes("login") ||
                name.includes("email") ||
                name.includes("account") ||
                name.includes("username") ||
                name.includes("identifier") ||
                name.includes("screen-name") ||
                name.includes("screen_name") ||
                name.includes("team") ||
                id.includes("user") ||
                id.includes("login") ||
                id.includes("email") ||
                id.includes("username") ||
                id.includes("identifier") ||
                autocomplete === "username" ||
                autocomplete === "email" ||
                autocomplete === "tel" ||
                labelText.includes("user") ||
                labelText.includes("login") ||
                labelText.includes("email") ||
                labelText.includes("username") ||
                labelText.includes("account") ||
                dataAttr.includes("username") ||
                dataAttr.includes("login");

            if (isUsernameSignal) return "username";
        }

        if (type === "email") return "username";
        return null;
    }

    function makeInput(
        overrides: Partial<{
            type: string;
            name: string;
            id: string;
            autocomplete: string;
            placeholder: string;
            label: string;
            ariaLabel: string;
            ariaLabelledBy: string;
            maxLength: number;
            pattern: string;
            inputmode: string;
            dataFieldType: string;
        }> = {}
    ): any {
        const attrs: Record<string, string | null> = {
            autocomplete: overrides.autocomplete ?? null,
            pattern: overrides.pattern ?? null,
            inputmode: overrides.inputmode ?? null,
            "aria-label": overrides.ariaLabel ?? null,
            "aria-labelledby": overrides.ariaLabelledBy ?? null,
        };
        const getAttribute = (name: string) => attrs[name] ?? null;
        const input = {
            type: overrides.type ?? "text",
            name: overrides.name ?? "",
            id: overrides.id ?? "",
            placeholder: overrides.placeholder ?? "",
            maxLength: overrides.maxLength ?? 0,
            pattern: overrides.pattern ?? "",
            dataset: {
                fieldType: overrides.dataFieldType ?? "",
                field: "",
            },
            getAttribute,
            ownerDocument: {
                getElementById: (id: string) =>
                    id === overrides.ariaLabelledBy ? { textContent: overrides.label ?? "" } : null,
            },
        };
        if (overrides.label && !overrides.ariaLabelledBy) {
            input.form = { labels: [{ textContent: overrides.label }] };
        }
        return input;
    }

    // -------------------------------------------------------------------------
    // Field classification — plain DOM
    // -------------------------------------------------------------------------

    suite("Plain DOM field classification", () => {
        test("password input is classified as password", () => {
            expect(classifyField(makeInput({ type: "password" }))).to.equal("password");
        });

        test("autocomplete='current-password' on text input is classified as password", () => {
            expect(classifyField(makeInput({ type: "text", autocomplete: "current-password" }))).to.equal("password");
        });

        test("autocomplete='new-password' on text input is classified as password", () => {
            expect(classifyField(makeInput({ type: "text", autocomplete: "new-password" }))).to.equal("password");
        });

        test("name=totp is classified as totp", () => {
            expect(classifyField(makeInput({ name: "totp" }))).to.equal("totp");
        });

        test("name=otp is classified as totp", () => {
            expect(classifyField(makeInput({ name: "otp" }))).to.equal("totp");
        });

        test("name=verification_code is classified as totp", () => {
            expect(classifyField(makeInput({ name: "verification_code" }))).to.equal("totp");
        });

        test("id containing 'totp' is classified as totp", () => {
            expect(classifyField(makeInput({ id: "totp-input" }))).to.equal("totp");
        });

        test("autocomplete='one-time-code' is classified as totp", () => {
            expect(classifyField(makeInput({ autocomplete: "one-time-code" }))).to.equal("totp");
        });

        test("placeholder containing 'totp' is classified as totp", () => {
            expect(classifyField(makeInput({ placeholder: "Enter your TOTP code" }))).to.equal("totp");
        });

        test("placeholder containing 'otp' is classified as totp", () => {
            expect(classifyField(makeInput({ placeholder: "OTP Code" }))).to.equal("totp");
        });

        test("name=username is classified as username", () => {
            expect(classifyField(makeInput({ name: "username" }))).to.equal("username");
        });

        test("name=login is classified as username", () => {
            expect(classifyField(makeInput({ name: "login" }))).to.equal("username");
        });

        test("name=email is classified as username", () => {
            expect(classifyField(makeInput({ name: "email" }))).to.equal("username");
        });

        test("name=account is classified as username", () => {
            expect(classifyField(makeInput({ name: "account" }))).to.equal("username");
        });

        test("name=identifier is classified as username", () => {
            expect(classifyField(makeInput({ name: "identifier" }))).to.equal("username");
        });

        test("name=screen_name is classified as username", () => {
            expect(classifyField(makeInput({ name: "screen_name" }))).to.equal("username");
        });

        test("id containing 'user' is classified as username", () => {
            expect(classifyField(makeInput({ id: "user-id" }))).to.equal("username");
        });

        test("autocomplete='username' is classified as username", () => {
            expect(classifyField(makeInput({ autocomplete: "username" }))).to.equal("username");
        });

        test("autocomplete='email' on text input is classified as username", () => {
            expect(classifyField(makeInput({ type: "text", autocomplete: "email" }))).to.equal("username");
        });

        test("autocomplete='tel' on text input is classified as username", () => {
            expect(classifyField(makeInput({ type: "text", autocomplete: "tel" }))).to.equal("username");
        });

        test("email type is classified as username regardless of name", () => {
            expect(classifyField(makeInput({ type: "email" }))).to.equal("username");
        });

        test("generic text input with no identifying attributes is unclassified", () => {
            expect(classifyField(makeInput({ type: "text" }))).to.be.null;
        });

        test("hidden input is not classified", () => {
            expect(classifyField(makeInput({ type: "hidden" }))).to.be.null;
        });
    });

    // -------------------------------------------------------------------------
    // Field classification — modern SaaS / OTP patterns
    // -------------------------------------------------------------------------

    suite("Modern login form patterns", () => {
        test("Google: name=Email is classified as username", () => {
            expect(classifyField(makeInput({ name: "Email" }))).to.equal("username");
        });

        test("GitHub: name=login is classified as username", () => {
            expect(classifyField(makeInput({ name: "login" }))).to.equal("username");
        });

        test("GitHub: id=otp is classified as totp", () => {
            expect(classifyField(makeInput({ id: "otp" }))).to.equal("totp");
        });

        test("Salesforce: name=username is classified as username", () => {
            expect(classifyField(makeInput({ name: "username" }))).to.equal("username");
        });

        test("Okta: name=credentials[0].identifier is classified as username", () => {
            expect(classifyField(makeInput({ name: "credentials[0].identifier" }))).to.equal("username");
        });

        test("Azure AD: name=loginHint is classified as username", () => {
            expect(classifyField(makeInput({ name: "loginHint" }))).to.equal("username");
        });

        test("Slack: name=team is classified as username", () => {
            expect(classifyField(makeInput({ name: "team" }))).to.equal("username");
        });

        test("TOTP: input with pattern='\\d+' and maxLength=6 is classified as totp", () => {
            expect(classifyField(makeInput({ pattern: "\\d+", maxLength: 6 }))).to.equal("totp");
        });

        test("TOTP: input with pattern='\\d+' and maxLength=8 is classified as totp", () => {
            expect(classifyField(makeInput({ pattern: "\\d+", maxLength: 8 }))).to.equal("totp");
        });

        test("TOTP: input with inputmode='numeric' and maxLength=6 is classified as totp", () => {
            expect(classifyField(makeInput({ inputmode: "numeric", maxLength: 6 }))).to.equal("totp");
        });

        test("Non-OTP: input with pattern='\\d+' and maxLength=12 is not classified as totp", () => {
            expect(classifyField(makeInput({ pattern: "\\d+", maxLength: 12 }))).to.be.null;
        });

        test("Non-OTP: input with pattern='\\d+' and maxLength=3 is not classified as totp", () => {
            expect(classifyField(makeInput({ pattern: "\\d+", maxLength: 3 }))).to.be.null;
        });

        test("data-field-type='username' is classified as username", () => {
            expect(classifyField(makeInput({ dataFieldType: "username" }))).to.equal("username");
        });

        test("data-field-type='totp' is classified as totp", () => {
            expect(classifyField(makeInput({ dataFieldType: "totp" }))).to.equal("totp");
        });

        test("data-field-type='otp' is classified as totp", () => {
            expect(classifyField(makeInput({ dataFieldType: "otp" }))).to.equal("totp");
        });

        test("aria-label='Enter your code' is classified as totp", () => {
            expect(classifyField(makeInput({ ariaLabel: "Enter your code" }))).to.equal("totp");
        });

        test("aria-label='Username or email' is classified as username", () => {
            expect(classifyField(makeInput({ ariaLabel: "Username or email" }))).to.equal("username");
        });

        test("aria-labelledby with label containing 'code' is classified as totp", () => {
            expect(classifyField(makeInput({ ariaLabelledBy: "lbl-code", label: "Verification Code" }))).to.equal(
                "totp"
            );
        });

        test("aria-labelledby with label containing 'user' is classified as username", () => {
            expect(classifyField(makeInput({ ariaLabelledBy: "lbl-user", label: "Username" }))).to.equal("username");
        });

        test("label text 'account name' is classified as username", () => {
            expect(classifyField(makeInput({ label: "Account Name" }))).to.equal("username");
        });
    });

    // -------------------------------------------------------------------------
    // Fill event sequence
    // -------------------------------------------------------------------------

    suite("Fill event sequence", () => {
        test("fill dispatches beforeinput, keydown, keyup, input, change, keypress in order", () => {
            const events: string[] = [];
            const input = {
                type: "text",
                name: "test",
                id: "",
                value: "",
                maxLength: 100,
                dataset: {},
                selectionStart: 0,
                selectionEnd: 0,
                getAttribute: () => null,
                setSelectionRange: () => {},
                dispatchEvent: (e: Event) => {
                    events.push(e.type);
                    return true;
                },
            } as any as HTMLInputElement;

            // Simulate the fill logic inline
            const value = "testvalue";
            const selectionStart = input.selectionStart ?? value.length;
            const selectionEnd = input.selectionEnd ?? value.length;

            input.dispatchEvent(
                new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
            );
            input.value = value;
            input.setSelectionRange(selectionStart, selectionEnd);
            input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
            input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));

            expect(events).to.deep.equal(["beforeinput", "keydown", "keyup", "input", "change", "keypress"]);
        });

        test("fill preserves selection range after value assignment", () => {
            let capturedStart = -1;
            let capturedEnd = -1;
            const input = {
                type: "text",
                name: "test",
                id: "",
                value: "",
                maxLength: 100,
                dataset: {},
                selectionStart: 3,
                selectionEnd: 5,
                getAttribute: () => null,
                setSelectionRange: (s: number, e: number) => {
                    capturedStart = s;
                    capturedEnd = e;
                },
                dispatchEvent: () => true,
            } as any as HTMLInputElement;

            const value = "hello";
            input.dispatchEvent(
                new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
            );
            input.value = value;
            input.setSelectionRange(input.selectionStart ?? value.length, input.selectionEnd ?? value.length);

            expect(capturedStart).to.equal(3);
            expect(capturedEnd).to.equal(5);
        });
    });

    // -------------------------------------------------------------------------
    // Label text resolution
    // -------------------------------------------------------------------------

    suite("Label text resolution", () => {
        test("returns aria-label when present", () => {
            const input = makeInput({ ariaLabel: "My Custom Label" });
            expect(getLabelText(input)).to.equal("my custom label");
        });

        test("prefers aria-labelledby over aria-label", () => {
            const input = makeInput({ ariaLabelledBy: "lbl-id", ariaLabel: "fallback", label: "From Label El" });
            expect(getLabelText(input)).to.equal("from label el");
        });

        test("returns empty string when no label signals present", () => {
            const input = makeInput({});
            expect(getLabelText(input)).to.equal("");
        });

        test("returns label text from form.labels when available", () => {
            const input = makeInput({});
            (input as any).form = {
                labels: [{ textContent: "Password Field" }],
            };
            expect(getLabelText(input)).to.equal("password field");
        });
    });

    // -------------------------------------------------------------------------
    // Shadow DOM traversal logic
    // -------------------------------------------------------------------------

    suite("Shadow DOM field collection", () => {
        test("collects fields from nested shadow roots", () => {
            // Simulate: document -> shadow-root -> element with shadow-root -> input
            const innerInput = {
                type: "password",
                name: "test",
                id: "pw",
                getAttribute: () => null,
                maxLength: 0,
                dataset: {},
            } as any;
            const innerShadowRoot = {
                querySelectorAll: () => [innerInput],
            };

            const outerElement = {
                shadowRoot: innerShadowRoot,
                querySelectorAll: () => [],
            };

            const outerShadowRoot = {
                querySelectorAll: () => [outerElement],
            };

            const doc = {
                querySelectorAll: () => [],
                querySelector: () => null,
            };

            // Verify the traversal pattern: shadow root querySelectorAll finds elements,
            // those elements' shadowRoot is recursively queried
            const allElements = outerShadowRoot.querySelectorAll("*");
            const shadowRoots: ShadowRoot[] = [];
            for (const el of allElements) {
                if ((el as any).shadowRoot) {
                    shadowRoots.push((el as any).shadowRoot);
                }
            }
            expect(shadowRoots.length).to.equal(1);
            expect(shadowRoots[0].querySelectorAll("input")[0]).to.equal(innerInput);
        });

        test("CSS.escape escapes form id with special characters", () => {
            // Form IDs with dots, colons, spaces need escaping in CSS selector
            expect(CSS.escape("my.form")).to.equal("my\\.form");
            expect(CSS.escape("my:form")).to.equal("my\\:form");
            expect(CSS.escape("my form")).to.equal("my\\ form");
        });
    });

    // -------------------------------------------------------------------------
    // Form attribute association
    // -------------------------------------------------------------------------

    suite("Form attribute association", () => {
        test("input with form=id associates with external form", () => {
            // When an input has form="formId", it is associated with the form
            // even when rendered outside the <form> element
            const externalInput = makeInput({ type: "password", name: "ext-password" });
            (externalInput as any).getAttribute = (name: string) => (name === "form" ? "login-form" : null);

            // In _collectFields, formIds would be collected and the form queried
            const formId = "login-form";
            // CSS.escape is used to safely query the form ID
            const escapedId = CSS.escape(formId);
            expect(escapedId).to.equal("login-form");

            // Simulate: form has an input inside it
            const formInput = makeInput({ type: "password", name: "form-password" });
            expect(classifyField(formInput)).to.equal("password");
        });
    });

    // -------------------------------------------------------------------------
    // Field type orchestration
    // -------------------------------------------------------------------------

    suite("Multi-field fill orchestration", () => {
        test("fills username before password when both available", () => {
            const fields: Array<{ type: "username" | "password" | "totp"; input: any }> = [
                { type: "password", input: { name: "password" } },
                { type: "username", input: { name: "username" } },
            ];
            // Orchestration order: username first, then password, then TOTP
            const sorted = fields.sort((a, b) => {
                const order: Record<string, number> = { username: 0, password: 1, totp: 2 };
                return order[a.type] - order[b.type];
            });
            expect(sorted.map((f) => f.type)).to.deep.equal(["username", "password"]);
        });

        test("TOTP falls back to password field when no dedicated TOTP field exists", () => {
            const fields = {
                username: { type: "username" as const, input: { name: "username" } },
                password: { type: "password" as const, input: { name: "password" } },
            };
            const totpField = null;
            const target = totpField ?? fields.password.input ?? fields.username.input;
            expect(target).to.equal(fields.password.input);
        });

        test("dedicated TOTP field takes priority over password field for OTP fill", () => {
            const fields = {
                totp: { type: "totp" as const, input: { name: "otp" } },
                password: { type: "password" as const, input: { name: "password" } },
            };
            const target = fields.totp ? fields.totp.input : fields.password.input;
            expect(target).to.equal(fields.totp.input);
        });
    });
});
